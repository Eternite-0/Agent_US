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

const MUTATING_TOOLS = new Set([
  'edit_file',
  'write_file',
  'apply_patch',
  'bash',
  'start_process',
  'kill_process',
]);

const BASE_CAPABILITIES = Object.freeze({
  research: {
    id: 'research',
    label: '代码库调研与情报检索',
    defaultMaxSteps: 8,
    readOnly: true,
    weights: { coding: 0.4, reasoning: 0.6, research: 1.0, planning: 0.3, speed: 0.7, contextCapacity: 0.8, multimodal: 0.1, toolCompatibility: 0.8 },
    toolAllow: ['read_file', 'glob', 'grep', 'read_blob', 'web_fetch', 'search_history', 'inspect_repository', 'query_symbol_graph'],
    toolCeiling: ['read_file', 'glob', 'grep', 'read_blob', 'web_fetch', 'search_history', 'inspect_repository', 'query_symbol_graph', 'read_swarm_artifact'],
    instruction: '专注于只读代码检索、调用链梳理与事实提取，引用精确文件路径与符号名。',
  },
  implementation: {
    id: 'implementation',
    label: '工程实现与增量修改',
    defaultMaxSteps: 20,
    readOnly: false,
    weights: { coding: 1.0, reasoning: 0.7, research: 0.4, planning: 0.4, speed: 0.5, contextCapacity: 0.6, multimodal: 0.1, toolCompatibility: 1.0 },
    toolAllow: ['read_file', 'glob', 'grep', 'edit_file', 'write_file', 'apply_patch', 'read_blob', 'inspect_repository', 'query_symbol_graph'],
    worktreeToolAllow: ['read_file', 'glob', 'grep', 'edit_file', 'write_file', 'apply_patch', 'read_blob', 'inspect_repository', 'query_symbol_graph', 'bash'],
    toolCeiling: ['read_file', 'glob', 'grep', 'edit_file', 'write_file', 'apply_patch', 'read_blob', 'inspect_repository', 'query_symbol_graph', 'read_swarm_artifact'],
    worktreeToolCeiling: ['read_file', 'glob', 'grep', 'edit_file', 'write_file', 'apply_patch', 'read_blob', 'inspect_repository', 'query_symbol_graph', 'bash', 'read_process_output', 'read_swarm_artifact'],
    instruction: '编写模块化、高内聚的生产级代码修改，保持既有接口与风格一致；在隔离 worktree 中可运行局部测试或构建命令自检。',
  },
  verification: {
    id: 'verification',
    label: '测试验证与诊断修复',
    defaultMaxSteps: 10,
    readOnly: false,
    weights: { coding: 0.8, reasoning: 0.8, research: 0.5, planning: 0.3, speed: 0.6, contextCapacity: 0.5, multimodal: 0.1, toolCompatibility: 1.0 },
    toolAllow: ['read_file', 'glob', 'grep', 'bash', 'read_process_output', 'read_blob', 'inspect_repository', 'query_symbol_graph'],
    toolCeiling: ['read_file', 'glob', 'grep', 'bash', 'read_process_output', 'read_blob', 'inspect_repository', 'query_symbol_graph', 'read_swarm_artifact'],
    instruction: '运行真实测试/编译检查并以可观测退出码与输出作为客观验证证据。',
  },
  planning: {
    id: 'planning',
    label: '架构规划与依赖拆解',
    defaultMaxSteps: 6,
    readOnly: true,
    weights: { coding: 0.25, reasoning: 1.4, research: 0.4, planning: 1.4, speed: 0.15, contextCapacity: 0.35, multimodal: 0.05, toolCompatibility: 0.4 },
    toolAllow: ['read_file', 'glob', 'grep', 'update_plan', 'search_history', 'inspect_repository', 'query_symbol_graph'],
    toolCeiling: ['read_file', 'glob', 'grep', 'update_plan', 'search_history', 'inspect_repository', 'query_symbol_graph', 'read_swarm_artifact'],
    instruction: '分析系统边界、状态流与模块依赖，产出无环可执行步骤与清晰验收标准。',
  },
  review: {
    id: 'review',
    label: '安全审计与质量复核',
    defaultMaxSteps: 8,
    readOnly: true,
    weights: { coding: 0.8, reasoning: 0.9, research: 0.7, planning: 0.4, speed: 0.5, contextCapacity: 0.8, multimodal: 0.1, toolCompatibility: 0.7 },
    toolAllow: ['read_file', 'glob', 'grep', 'read_blob'],
    toolCeiling: ['read_file', 'glob', 'grep', 'read_blob', 'inspect_repository', 'query_symbol_graph', 'read_swarm_artifact'],
    instruction: '独立核对实现边界、回归风险、错误处理与权限安全，禁止直接篡改产物。',
  },
});

function inferSpecializedRoleTitle(baseKey, taskType, objective, explicitTitle) {
  if (explicitTitle && String(explicitTitle).trim()) {
    return String(explicitTitle).trim().slice(0, 120);
  }
  const cleanType = String(taskType || '').trim();
  if (cleanType && !Object.hasOwn(BASE_CAPABILITIES, cleanType)) {
    return cleanType.slice(0, 120);
  }
  const text = String(objective || '').toLowerCase();
  if (baseKey === 'implementation') {
    if (/frontend|ui|react|css|component|组件|前端|样式/i.test(text)) return 'Frontend UI Specialist';
    if (/api|route|server|backend|db|sqlite|后端|接口|路由/i.test(text)) return 'Backend Systems Specialist';
    if (/repair|fix|patch|bug|修复|补丁/i.test(text)) return 'Targeted Repair Specialist';
    if (/test|spec|fixture|测试|用例/i.test(text)) return 'Test Authoring Specialist';
  }
  if (baseKey === 'verification') {
    return 'Integration & Test Verifier';
  }
  if (baseKey === 'review') {
    if (/security|auth|policy|permission|安全|权限/i.test(text)) return 'Security & Policy Auditor';
    return 'Independent Code Reviewer';
  }
  if (baseKey === 'research') {
    return 'Repository Architecture Researcher';
  }
  return BASE_CAPABILITIES[baseKey]?.label ?? 'Autonomous Specialist';
}

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
    const allAccounts =
      typeof this.pool?.listAccounts === 'function'
        ? this.pool.listAccounts()
        : [];
    const accounts =
      typeof this.pool?.listAccounts === 'function'
        ? this.pool.listAccounts({ enabled: true })
        : [];
    const accountByPreset = new Map();
    for (const acc of allAccounts) {
      if (acc?.preset && !accountByPreset.has(acc.preset)) {
        accountByPreset.set(acc.preset, false);
      }
    }
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
        const hasAnyAccounts = allAccounts.length > 0;
        const healthy = targets.length
          ? targets.some((t) => {
              if (accountByPreset.has(t.provider)) return accountByPreset.get(t.provider);
              return !hasAnyAccounts;
            })
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
      const hasRoute =
        typeof this.pool?.resolveRoutes === 'function' && allAccounts.length > 0
          ? this.pool.resolveRoutes(def).length > 0
          : allAccounts.length === 0 || [...accountByPreset.values()].some(Boolean);
      if (hasRoute || this.entries.size === 0) {
        this.entries.set(
          def,
          scoreModelCapabilities(def, {
            preset: 'pool',
            profile: { contextWindow: this.pool.getModelContextWindow?.(def) ?? 128000 },
            healthy: hasRoute,
          }),
        );
      }
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
    isolationMode = null,
    isolatedWorktree = false,
    roleTitle = null,
    focus = null,
    ownedPaths = null,
  } = {}) {
    const hint = `${taskType} ${objective}`.toLowerCase();
    let baseKey = 'research';
    if (this.archetypes.has(taskType)) {
      baseKey = taskType;
    } else if (taskType === 'conflict_resolution') {
      baseKey = 'implementation';
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
    const isSharedReadonly = isolationMode === 'shared_readonly';
    const isWorktree = !isSharedReadonly && (isolatedWorktree === true || isolationMode === 'worktree');
    const forcedReadOnly = Boolean(base.readOnly || readOnly === true || isSharedReadonly);

    const rawCeiling =
      isWorktree && Array.isArray(base.worktreeToolCeiling)
        ? base.worktreeToolCeiling
        : Array.isArray(base.toolCeiling)
          ? base.toolCeiling
          : base.toolAllow;
    const ceilingList = forcedReadOnly
      ? rawCeiling.filter((t) => !MUTATING_TOOLS.has(t))
      : [...rawCeiling];
    const ceilingSet = new Set(ceilingList);

    const defaultTools =
      isWorktree && Array.isArray(base.worktreeToolAllow)
        ? base.worktreeToolAllow
        : base.toolAllow;

    let effectiveTools;
    if (Array.isArray(requiredTools)) {
      // Preserve explicit `[]` and enforce archetype ceiling on non-empty allowlists
      effectiveTools = [...new Set(requiredTools.map(String))].filter((t) => ceilingSet.has(t));
    } else {
      effectiveTools = forcedReadOnly
        ? defaultTools.filter((t) => !MUTATING_TOOLS.has(t))
        : [...defaultTools];
    }

    const isReadOnly =
      forcedReadOnly ||
      !effectiveTools.some((t) => MUTATING_TOOLS.has(t));

    const resolvedRoleTitle = inferSpecializedRoleTitle(baseKey, taskType, objective, roleTitle);
    const resolvedFocus = focus && String(focus).trim() ? String(focus).trim().slice(0, 240) : null;
    const resolvedOwnedPaths = Array.isArray(ownedPaths)
      ? [...new Set(ownedPaths.map((p) => String(p).trim()).filter(Boolean))].slice(0, 32)
      : [];

    return {
      id: `dynamic:${baseKey}`,
      archetype: baseKey,
      name: resolvedRoleTitle,
      roleTitle: resolvedRoleTitle,
      focus: resolvedFocus,
      ownedPaths: resolvedOwnedPaths,
      readOnly: isReadOnly,
      defaultMaxSteps: maxSteps ?? base.defaultMaxSteps,
      weights: { ...base.weights },
      toolAllow: effectiveTools,
      toolCeiling: ceilingList,
      staticSystemInstruction: base.instruction,
    };
  }
}
