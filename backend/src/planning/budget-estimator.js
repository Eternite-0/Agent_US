const PROFILE_PRESETS = Object.freeze({
  'codebase-analysis': {
    baseSteps: 12,
    tokensPerStep: 2800,
    ratios: { planning: 0.05, research: 0.50, implementation: 0.05, testing: 0.05, review: 0.25, repair: 0.00, finalVerification: 0.10 },
  },
  research: {
    baseSteps: 10,
    tokensPerStep: 2500,
    ratios: { planning: 0.05, research: 0.55, implementation: 0.00, testing: 0.05, review: 0.20, repair: 0.05, finalVerification: 0.10 },
  },
  'bug-fix': {
    baseSteps: 12,
    tokensPerStep: 3000,
    ratios: { planning: 0.10, research: 0.20, implementation: 0.35, testing: 0.15, review: 0.05, repair: 0.05, finalVerification: 0.10 },
  },
  tests: {
    baseSteps: 12,
    tokensPerStep: 2800,
    ratios: { planning: 0.10, research: 0.20, implementation: 0.30, testing: 0.20, review: 0.05, repair: 0.05, finalVerification: 0.10 },
  },
  'api-compat': {
    baseSteps: 12,
    tokensPerStep: 2800,
    ratios: { planning: 0.10, research: 0.20, implementation: 0.35, testing: 0.15, review: 0.05, repair: 0.05, finalVerification: 0.10 },
  },
  'multi-file-feature': {
    baseSteps: 14,
    tokensPerStep: 3200,
    ratios: { planning: 0.15, research: 0.20, implementation: 0.35, testing: 0.15, review: 0.05, repair: 0.02, finalVerification: 0.08 },
  },
  implementation: {
    baseSteps: 14,
    tokensPerStep: 3200,
    ratios: { planning: 0.12, research: 0.18, implementation: 0.38, testing: 0.15, review: 0.05, repair: 0.04, finalVerification: 0.08 },
  },
  refactor: {
    baseSteps: 15,
    tokensPerStep: 3200,
    ratios: { planning: 0.12, research: 0.20, implementation: 0.36, testing: 0.15, review: 0.05, repair: 0.04, finalVerification: 0.08 },
  },
  'data-processing': {
    baseSteps: 14,
    tokensPerStep: 3000,
    ratios: { planning: 0.10, research: 0.20, implementation: 0.36, testing: 0.16, review: 0.05, repair: 0.03, finalVerification: 0.10 },
  },
  'security-audit': {
    baseSteps: 16,
    tokensPerStep: 3500,
    ratios: { planning: 0.10, research: 0.28, implementation: 0.24, testing: 0.14, review: 0.10, repair: 0.04, finalVerification: 0.10 },
  },
  recovery: {
    baseSteps: 17,
    tokensPerStep: 3500,
    ratios: { planning: 0.12, research: 0.20, implementation: 0.30, testing: 0.16, review: 0.06, repair: 0.06, finalVerification: 0.10 },
  },
  'multi-agent': {
    baseSteps: 18,
    tokensPerStep: 3600,
    ratios: { planning: 0.12, research: 0.18, implementation: 0.30, testing: 0.14, review: 0.12, repair: 0.04, finalVerification: 0.10 },
  },
  review: {
    baseSteps: 8,
    tokensPerStep: 2500,
    ratios: { planning: 0.00, research: 0.35, implementation: 0.00, testing: 0.05, review: 0.40, repair: 0.00, finalVerification: 0.20 },
  },
  verification: {
    baseSteps: 8,
    tokensPerStep: 2400,
    ratios: { planning: 0.00, research: 0.20, implementation: 0.00, testing: 0.50, review: 0.10, repair: 0.00, finalVerification: 0.20 },
  },
  general: {
    baseSteps: 12,
    tokensPerStep: 2800,
    ratios: { planning: 0.10, research: 0.25, implementation: 0.30, testing: 0.15, review: 0.05, repair: 0.05, finalVerification: 0.10 },
  },
});

const COMPLEXITY_STEP_BONUS = Object.freeze({ low: 0, medium: 2, high: 5 });

function normalizeTaskType(taskType = 'general') {
  const key = String(taskType || 'general').trim().toLowerCase();
  if (PROFILE_PRESETS[key]) return key;
  if (key.includes('security') || key.includes('audit')) return 'security-audit';
  if (key.includes('recover')) return 'recovery';
  if (key.includes('multi-agent') || key.includes('multiagent')) return 'multi-agent';
  if (key.includes('analysis')) return 'codebase-analysis';
  if (key.includes('refactor')) return 'refactor';
  if (key.includes('bug')) return 'bug-fix';
  if (key.includes('feature')) return 'multi-file-feature';
  if (key.includes('compat')) return 'api-compat';
  if (key.includes('data')) return 'data-processing';
  if (key.includes('test')) return 'tests';
  if (key.includes('review')) return 'review';
  if (key.includes('verif')) return 'verification';
  if (key.includes('impl')) return 'implementation';
  if (key.includes('research')) return 'research';
  return 'general';
}

function posIntOrNull(val) {
  if (val === null || val === undefined || val === '') return null;
  const n = Number(val);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : null;
}

export function queryHistoricalTaskMetrics(store, { taskType = null, model = null, limit = 50 } = {}) {
  if (!store?.db?.isOpen) {
    return { sampleCount: 0, avgTokens: null, avgSteps: null, failureRate: 0, budgetExhaustedRate: 0, adjustmentFactor: 1 };
  }
  try {
    const cap = Math.max(1, Math.min(200, Number(limit) || 50));
    let rows = [];
    if (taskType && model) {
      rows = store.db
        .prepare('SELECT success, failureKind, inputTokens, outputTokens FROM model_feedback WHERE taskType=? AND model=? ORDER BY createdAt DESC LIMIT ?')
        .all(String(taskType), String(model), cap);
    }
    if (rows.length < 3 && taskType) {
      rows = store.db
        .prepare('SELECT success, failureKind, inputTokens, outputTokens FROM model_feedback WHERE taskType=? ORDER BY createdAt DESC LIMIT ?')
        .all(String(taskType), cap);
    }
    if (rows.length === 0) {
      return { sampleCount: 0, avgTokens: null, avgSteps: null, failureRate: 0, budgetExhaustedRate: 0, adjustmentFactor: 1 };
    }
    const n = rows.length;
    const failures = rows.filter((r) => Number(r.success ?? 1) === 0).length;
    const budgetFails = rows.filter((r) => r.failureKind === 'budget').length;
    const avgTokens = Math.round(
      rows.reduce((sum, r) => sum + Number(r.inputTokens ?? 0) + Number(r.outputTokens ?? 0), 0) / n,
    );
    const budgetExhaustedRate = budgetFails / n;
    const failureRate = failures / n;
    const rawAdj = 1 + budgetExhaustedRate * 0.35 + Math.max(0, failureRate - 0.2) * 0.25;
    const adjustmentFactor = Number(Math.max(0.85, Math.min(1.35, rawAdj)).toFixed(3));
    return { sampleCount: n, avgTokens, avgSteps: null, failureRate, budgetExhaustedRate, adjustmentFactor };
  } catch {
    return { sampleCount: 0, avgTokens: null, avgSteps: null, failureRate: 0, budgetExhaustedRate: 0, adjustmentFactor: 1 };
  }
}

function distributeBuckets(totalSteps, ratios, finalVerificationReserve) {
  const reserve = Math.min(totalSteps, Math.max(0, finalVerificationReserve));
  const pool = Math.max(0, totalSteps - reserve);
  const keys = ['planning', 'research', 'implementation', 'testing', 'review', 'repair'];
  const ratioSum = keys.reduce((sum, k) => sum + Number(ratios[k] ?? 0), 0) || 1;
  const raw = {};
  let allocated = 0;
  for (const k of keys) {
    raw[k] = Math.floor((pool * Number(ratios[k] ?? 0)) / ratioSum);
    allocated += raw[k];
  }
  let remainder = pool - allocated;
  const sortedByRatio = [...keys].sort((a, b) => Number(ratios[b] ?? 0) - Number(ratios[a] ?? 0));
  let idx = 0;
  while (remainder > 0) {
    raw[sortedByRatio[idx % sortedByRatio.length]] += 1;
    remainder -= 1;
    idx += 1;
  }
  return {
    planningSteps: raw.planning,
    researchSteps: raw.research,
    implementationSteps: raw.implementation,
    testingSteps: raw.testing,
    reviewSteps: raw.review,
    repairReserve: raw.repair,
    finalVerificationReserve: reserve,
  };
}

export function estimateTaskBudget({
  taskType = 'general',
  fileCount = 1,
  requiredTools = [],
  dependencies = [],
  expectedArtifacts = [],
  verificationComplexity = 'medium',
  recoveryRequirements = false,
  historicalStats = null,
  userBudget = {},
  stageThresholdSteps = 24,
} = {}) {
  const normalizedType = normalizeTaskType(taskType);
  const preset = PROFILE_PRESETS[normalizedType] ?? PROFILE_PRESETS.general;
  const files = Math.max(1, Number(fileCount) || 1);
  const toolList = Array.isArray(requiredTools) ? requiredTools : [];
  const deps = Array.isArray(dependencies) ? dependencies : [];
  const artifacts = Array.isArray(expectedArtifacts) ? expectedArtifacts : [];
  const verifyBonus = COMPLEXITY_STEP_BONUS[String(verificationComplexity || 'medium').toLowerCase()] ?? 2;

  const fileSteps = Math.min(8, Math.max(0, files - 1));
  const toolBonus =
    (toolList.includes('bash') || toolList.includes('start_process') ? 2 : 0) +
    (toolList.includes('read_swarm_artifact') ? 1 : 0);
  const depBonus = Math.min(4, deps.length);
  const artifactBonus = Math.min(4, artifacts.length);
  const recoveryBonus = recoveryRequirements ? 5 : 0;

  const rawUnconstrained =
    preset.baseSteps + fileSteps + toolBonus + depBonus + artifactBonus + verifyBonus + recoveryBonus;
  const histFactor = Number.isFinite(Number(historicalStats?.adjustmentFactor))
    ? Math.max(0.85, Math.min(1.35, Number(historicalStats.adjustmentFactor)))
    : 1;
  const recommendedSteps = Math.max(4, Math.min(48, Math.round(rawUnconstrained * histFactor)));
  const desiredReserve = verificationComplexity === 'high' || recoveryRequirements ? 3 : 2;
  const minFeasibleSteps = Math.max(4, Math.min(recommendedSteps, desiredReserve + 3));

  const userMaxSteps = posIntOrNull(userBudget?.maxTotalSteps ?? userBudget?.maxSteps);
  const userMaxTokens = posIntOrNull(userBudget?.maxTotalTokens ?? userBudget?.maxTokens);

  let maxSteps = recommendedSteps;
  let feasible = true;
  let insufficientReason = null;

  if (userMaxSteps !== null) {
    if (userMaxSteps < minFeasibleSteps) {
      feasible = false;
      insufficientReason = `User step budget (${userMaxSteps}) is below minimum feasible steps (${minFeasibleSteps}, including ${desiredReserve}-step final verification reserve) for ${normalizedType}`;
      maxSteps = userMaxSteps;
    } else if (userMaxSteps < recommendedSteps) {
      maxSteps = userMaxSteps;
    }
  }

  const finalVerificationReserve = maxSteps >= 6 ? Math.min(desiredReserve, maxSteps - 2) : Math.min(1, maxSteps);
  const buckets = distributeBuckets(maxSteps, preset.ratios, finalVerificationReserve);
  const baselineTokensPerStep = Number(historicalStats?.avgTokens) > 0
    ? Math.max(1500, Math.min(8000, Math.round(Number(historicalStats.avgTokens) / Math.max(1, recommendedSteps * 0.4))))
    : preset.tokensPerStep;
  const estimatedTokens = maxSteps * baselineTokensPerStep;
  const maxTokens = userMaxTokens !== null ? Math.min(estimatedTokens, userMaxTokens) : estimatedTokens;

  if (userMaxTokens !== null && userMaxTokens < maxSteps * 500) {
    feasible = false;
    insufficientReason = insufficientReason
      || `User token budget (${userMaxTokens}) is insufficient for ${maxSteps} steps (minimum ${maxSteps * 500} tokens)`;
  }

  const threshold = Math.max(12, Number(stageThresholdSteps) || 24);
  const suggestedStages = recommendedSteps > threshold
    ? [
        { stage: 'analyze_and_plan', taskType: 'research', budgetSteps: buckets.planningSteps + buckets.researchSteps },
        { stage: 'implement_and_test', taskType: normalizedType, budgetSteps: buckets.implementationSteps + buckets.testingSteps + buckets.repairReserve },
        { stage: 'verify_and_finalize', taskType: 'verification', budgetSteps: buckets.reviewSteps + buckets.finalVerificationReserve },
      ]
    : [];

  return {
    taskType: normalizedType,
    recommendedSteps,
    maxSteps,
    minFeasibleSteps,
    estimatedTokens,
    maxTokens,
    ...buckets,
    feasible,
    insufficientReason,
    suggestedStages,
    factors: {
      fileCount: files,
      toolBonus,
      depBonus,
      artifactBonus,
      verifyBonus,
      recoveryBonus,
      historicalAdjustment: histFactor,
    },
  };
}

export function allocatePlanBudgets({
  tasks = [],
  userBudget = {},
  historicalByType = {},
  store = null,
  model = null,
  repoContext = null,
} = {}) {
  const list = Array.isArray(tasks) ? tasks : [];
  if (!list.length) {
    return {
      feasible: false,
      insufficientReason: 'Plan contains zero tasks',
      totalAllocatedSteps: 0,
      totalEstimatedTokens: 0,
      finalVerificationReserve: 0,
      userMaxSteps: posIntOrNull(userBudget?.maxTotalSteps ?? userBudget?.maxSteps),
      userMaxTokens: posIntOrNull(userBudget?.maxTotalTokens ?? userBudget?.maxTokens),
      tasks: [],
    };
  }

  const userMaxSteps = posIntOrNull(userBudget?.maxTotalSteps ?? userBudget?.maxSteps);
  const userMaxTokens = posIntOrNull(userBudget?.maxTotalTokens ?? userBudget?.maxTokens);
  const repoScaleFiles = repoContext
    ? Math.max(
        Number(repoContext.filesScanned || 0),
        Array.isArray(repoContext.relevantFiles) ? repoContext.relevantFiles.length : 0,
      )
    : 0;
  const scaledRepoFiles =
    repoScaleFiles >= 20
      ? Math.min(10, Math.ceil(Math.sqrt(repoScaleFiles)))
      : repoScaleFiles > 0
        ? Math.min(6, repoScaleFiles)
        : 2;

  const strictCheck = Boolean(userBudget?.strictBudgetCheck);
  const estimates = list.map((task) => {
    const explicitSteps = posIntOrNull(task.budget?.maxSteps ?? task.budget?.maxTotalSteps);
    const meta = task.metadata ?? {};
    const normType = normalizeTaskType(task.taskType || 'general');
    const hist = historicalByType[task.taskType] ?? queryHistoricalTaskMetrics(store, { taskType: task.taskType, model });
    const ownedCount = Array.isArray(task.ownedPaths)
      ? task.ownedPaths.length
      : Array.isArray(meta.ownedPaths)
        ? meta.ownedPaths.length
        : 0;
    const inferredTools = Array.isArray(task.toolAllow)
      ? task.toolAllow
      : Array.isArray(meta.requiredTools)
        ? meta.requiredTools
        : normType === 'review'
          ? ['read_file', 'read_swarm_artifact']
          : ['implementation', 'bug-fix', 'refactor', 'multi-file-feature', 'tests', 'verification'].includes(normType)
            ? ['read_file', 'write_file', 'edit_file', 'bash']
            : [];
    const inferredComplexity =
      meta.verificationComplexity ??
      (normType === 'review'
        ? 'low'
        : ['verification', 'implementation', 'bug-fix', 'refactor', 'multi-file-feature', 'tests'].includes(normType) &&
            repoScaleFiles >= 20
          ? 'high'
          : 'medium');
    const est = estimateTaskBudget({
      taskType: task.taskType || 'general',
      fileCount: Number(
        meta.fileCount ??
          Math.max(
            ownedCount,
            Array.isArray(meta.expectedArtifacts) ? meta.expectedArtifacts.length : 0,
            scaledRepoFiles,
          ),
      ),
      requiredTools: inferredTools,
      dependencies: task.dependencies ?? [],
      expectedArtifacts: meta.expectedArtifacts ?? [],
      verificationComplexity: inferredComplexity,
      recoveryRequirements: Boolean(meta.recoveryRequirements || /recover|checkpoint|sigkill|audit/i.test(String(task.objective ?? ''))),
      historicalStats: hist,
      userBudget: {},
    });
    const minSteps = explicitSteps !== null
      ? explicitSteps
      : (strictCheck ? Math.max(2, Math.min(est.allocatedSteps ?? est.maxSteps, 1 + est.finalVerificationReserve)) : 1);
    return {
      task,
      explicitSteps,
      est,
      allocatedSteps: explicitSteps !== null ? explicitSteps : est.maxSteps,
      minSteps,
    };
  });

  if (userMaxTokens !== null && userMaxTokens < list.length * 200) {
    return {
      feasible: false,
      insufficientReason: `Requested token budget (${userMaxTokens}) is below minimum feasible tokens (${list.length * 200}) across ${list.length} task(s)`,
      totalAllocatedSteps: estimates.reduce((s, item) => s + item.allocatedSteps, 0),
      totalEstimatedTokens: userMaxTokens,
      finalVerificationReserve: Math.min(2, userMaxSteps ?? 2),
      userMaxSteps,
      userMaxTokens,
      tasks: estimates.map((item) => ({
        taskKey: item.task.taskKey ?? item.task.nodeKey,
        allocatedSteps: item.minSteps,
        estimate: item.est,
      })),
    };
  }
  const totalMinSteps = estimates.reduce((s, item) => s + item.minSteps, 0);
  if (userMaxSteps !== null && userMaxSteps < totalMinSteps) {
    return {
      feasible: false,
      insufficientReason: `Requested total step budget (${userMaxSteps}) cannot cover minimum feasible steps (${totalMinSteps}) across ${list.length} task(s) with verification reserves`,
      totalAllocatedSteps: userMaxSteps,
      totalEstimatedTokens: estimates.reduce((s, item) => s + item.est.estimatedTokens, 0),
      finalVerificationReserve: Math.min(2, userMaxSteps),
      userMaxSteps,
      userMaxTokens,
      tasks: estimates.map((item) => ({
        taskKey: item.task.taskKey ?? item.task.nodeKey,
        allocatedSteps: Math.min(item.minSteps, userMaxSteps),
        estimate: item.est,
      })),
    };
  }

  let totalAllocated = estimates.reduce((s, item) => s + item.allocatedSteps, 0);
  if (repoScaleFiles >= 20 && userMaxSteps !== null && totalAllocated < userMaxSteps) {
    let spare = userMaxSteps - totalAllocated;
    for (const item of estimates) {
      if (spare <= 0) break;
      if (item.explicitSteps !== null) continue;
      const normType = normalizeTaskType(item.task.taskType || 'general');
      if (
        !['implementation', 'tests', 'verification', 'multi-file-feature', 'bug-fix', 'refactor'].includes(
          normType,
        )
      ) {
        continue;
      }
      const targetCap = Math.min(36, Math.ceil(item.allocatedSteps * 1.2));
      const add = Math.min(spare, Math.max(0, targetCap - item.allocatedSteps));
      if (add > 0) {
        item.allocatedSteps += add;
        spare -= add;
      }
    }
    totalAllocated = estimates.reduce((s, item) => s + item.allocatedSteps, 0);
  }
  if (userMaxSteps !== null && totalAllocated > userMaxSteps) {
    // Proportionally trim unconstrained (non-explicit) slack above minSteps
    const fixedSteps = estimates.filter((i) => i.explicitSteps !== null).reduce((s, i) => s + i.explicitSteps, 0);
    const adjustable = estimates.filter((i) => i.explicitSteps === null);
    const availableForAdjustable = Math.max(0, userMaxSteps - fixedSteps);
    const currentAdjustable = adjustable.reduce((s, i) => s + i.allocatedSteps, 0) || 1;
    let assigned = 0;
    for (const item of adjustable) {
      const scaled = Math.max(item.minSteps, Math.floor((availableForAdjustable * item.allocatedSteps) / currentAdjustable));
      item.allocatedSteps = scaled;
      assigned += scaled;
    }
    let excess = fixedSteps + assigned - userMaxSteps;
    let idx = 0;
    while (excess > 0 && adjustable.some((i) => i.allocatedSteps > 1)) {
      const candidate = adjustable[idx % adjustable.length];
      if (candidate.allocatedSteps > 1) {
        candidate.allocatedSteps -= 1;
        excess -= 1;
      }
      idx += 1;
    }
    totalAllocated = estimates.reduce((s, item) => s + item.allocatedSteps, 0);
  }

  const totalTokens = estimates.reduce((s, item) => s + item.est.estimatedTokens, 0);
  const clampedTotalTokens = userMaxTokens !== null ? Math.min(totalTokens, userMaxTokens) : totalTokens;
  const finalReserveTotal = estimates.reduce((s, item) => s + Math.min(item.allocatedSteps, item.est.finalVerificationReserve), 0);

  return {
    feasible: totalAllocated <= (userMaxSteps ?? Infinity),
    insufficientReason: null,
    totalAllocatedSteps: totalAllocated,
    totalEstimatedTokens: clampedTotalTokens,
    finalVerificationReserve: finalReserveTotal,
    userMaxSteps,
    userMaxTokens,
    tasks: estimates.map((item) => ({
      taskKey: item.task.taskKey ?? item.task.nodeKey,
      allocatedSteps: item.allocatedSteps,
      finalVerificationReserve: Math.min(Math.max(1, item.est.finalVerificationReserve), Math.max(0, item.allocatedSteps - 1)),
      estimate: item.est,
    })),
  };
}
