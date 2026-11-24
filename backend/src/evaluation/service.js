import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { EvaluationRunner } from './runner.js';
import { EvaluationRecorder } from './recorder.js';
import { EvaluationRegistry } from './registry.js';
import { createBenchmarkDataset, createRealEngineeringDataset } from './dataset.js';
import {
  ACI_ARM_PROFILES,
  computeWilson95CI,
  exportPaperTablesLatex,
  exportPaperTablesMarkdown,
} from './aci-governance-benchmark.js';
import {
  OSS_BENCHMARK_ID,
  OSS_BENCHMARK_VERSION,
  OSS_DATASET_VERSION,
  createOssBenchmarkDataset,
} from './external-benchmark.js';
import { createFixtureWorkspace, createGitRepoWorkspace } from './fixtures.js';
import { compareRegression } from './regression.js';
import { TRAFFIC_SOURCES, withTraceContext } from '../observability/trace.js';
import { redactSecrets } from '../envelope.js';
import { extractResultTelemetry, scoreResults } from './scoring.js';
import { estimateTaskBudget, queryHistoricalTaskMetrics } from '../planning/budget-estimator.js';
import { BenchmarkSandbox } from '../tools/benchmark-sandbox.js';
import { DEFAULT_DEPENDENCY_POLICY } from './dependency-policy.js';

export const BENCHMARK_ID = 'agent-us-deterministic-core';
export const BENCHMARK_VERSION = '1.0.0';
export const DATASET_VERSION = '1.0.0';
export const REAL_ENGINEERING_BENCHMARK_ID = 'agent-us-real-engineering';
export const REAL_ENGINEERING_BENCHMARK_VERSION = '1.0.0';
export const REAL_ENGINEERING_DATASET_VERSION = '1.0.0';
export { OSS_BENCHMARK_ID, OSS_BENCHMARK_VERSION, OSS_DATASET_VERSION };
const TERMINAL_TURN_STATES = new Set(['completed', 'failed', 'cancelled']);
const TERMINAL_EVALUATION_STATUSES = new Set(['passed', 'failed', 'cancelled', 'timeout']);
export const DEFAULT_ACI_EVIDENCE_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'docs',
  'evidence',
);

function normalizeAblationArmSummary(arm, rawArm = {}, armProfiles = {}) {
  const passedTrials = Math.max(0, Math.trunc(Number(rawArm?.passedTrials ?? 0) || 0));
  const totalTrials = Math.max(0, Math.trunc(Number(rawArm?.totalTrials ?? 0) || 0));
  const failedTrials = Math.max(
    0,
    Math.trunc(Number(rawArm?.failedTrials ?? Math.max(0, totalTrials - passedTrials)) || 0),
  );
  const rawCi = rawArm?.passRateCI;
  const passRateCI =
    rawCi && typeof rawCi === 'object' && Number.isFinite(Number(rawCi.rate))
      ? {
          rate: Number(rawCi.rate),
          lower: Number(rawCi.lower ?? 0),
          upper: Number(rawCi.upper ?? 0),
          ci95HalfWidth: Number(
            rawCi.ci95HalfWidth ?? Number(((Number(rawCi.upper ?? 0) - Number(rawCi.lower ?? 0)) / 2).toFixed(4)),
          ),
        }
      : computeWilson95CI(passedTrials, totalTrials);
  const supRaw = rawArm?.supervisorCost && typeof rawArm.supervisorCost === 'object' ? rawArm.supervisorCost : {};
  const tokRaw = rawArm?.tokenBreakdown && typeof rawArm.tokenBreakdown === 'object' ? rawArm.tokenBreakdown : {};
  const decRaw = rawArm?.decisions && typeof rawArm.decisions === 'object' ? rawArm.decisions : {};
  return {
    arm,
    aciProfile:
      armProfiles?.[arm]?.aciProfile ??
      rawArm?.aciProfile ??
      ACI_ARM_PROFILES[arm]?.aciProfile ??
      null,
    passedTrials,
    totalTrials,
    failedTrials,
    passRateCI,
    pairedPassTokenReduction:
      rawArm?.pairedPassTokenReduction == null ? null : Number(rawArm.pairedPassTokenReduction),
    pairedPassCount: Math.max(0, Math.trunc(Number(rawArm?.pairedPassCount ?? 0) || 0)),
    tokensPerCompletedPass:
      rawArm?.tokensPerCompletedPass == null ? null : Number(rawArm.tokensPerCompletedPass),
    meanTokensOnPassedTrials:
      rawArm?.meanTokensOnPassedTrials == null ? null : Number(rawArm.meanTokensOnPassedTrials),
    tokenReduction: Number(rawArm?.tokenReduction ?? 0) || 0,
    criticalContextRecall: Number(rawArm?.criticalContextRecall ?? 0) || 0,
    contextPrecision: Number(rawArm?.contextPrecision ?? 0) || 0,
    falseNegativeRate: Number(rawArm?.falseNegativeRate ?? 0) || 0,
    usefulTokenRatio: Number(rawArm?.usefulTokenRatio ?? 0) || 0,
    cacheHitRate: Number(rawArm?.cacheHitRate ?? 0) || 0,
    recoverySuccessRate: Number(rawArm?.recoverySuccessRate ?? 0) || 0,
    finalTaskSuccessRate:
      rawArm?.finalTaskSuccessRate != null
        ? Number(rawArm.finalTaskSuccessRate)
        : totalTrials > 0
          ? Number((passedTrials / totalTrials).toFixed(4))
          : 0,
    supervisorCost: {
      calls: Math.max(0, Math.trunc(Number(supRaw.calls ?? 0) || 0)),
      inputTokens: Math.max(0, Math.trunc(Number(supRaw.inputTokens ?? 0) || 0)),
      outputTokens: Math.max(0, Math.trunc(Number(supRaw.outputTokens ?? 0) || 0)),
      totalTokens: Math.max(0, Math.trunc(Number(supRaw.totalTokens ?? 0) || 0)),
      durationMs: Math.max(0, Math.trunc(Number(supRaw.durationMs ?? 0) || 0)),
      tokenShareOfTotal: Number(supRaw.tokenShareOfTotal ?? 0) || 0,
    },
    tokenBreakdown: {
      totalTokens: Math.max(0, Math.trunc(Number(tokRaw.totalTokens ?? 0) || 0)),
      meanTokens: Math.max(0, Math.trunc(Number(tokRaw.meanTokens ?? 0) || 0)),
      inputTokens: Math.max(0, Math.trunc(Number(tokRaw.inputTokens ?? 0) || 0)),
      outputTokens: Math.max(0, Math.trunc(Number(tokRaw.outputTokens ?? 0) || 0)),
      cacheReadTokens: Math.max(0, Math.trunc(Number(tokRaw.cacheReadTokens ?? 0) || 0)),
      cacheWriteTokens: Math.max(0, Math.trunc(Number(tokRaw.cacheWriteTokens ?? 0) || 0)),
      eligibleInputTokens: Math.max(0, Math.trunc(Number(tokRaw.eligibleInputTokens ?? 0) || 0)),
    },
    supersededEvictions: Math.max(0, Math.trunc(Number(rawArm?.supersededEvictions ?? 0) || 0)),
    supersededTokensSaved: Math.max(0, Math.trunc(Number(rawArm?.supersededTokensSaved ?? 0) || 0)),
    partialRecoveries: Math.max(0, Math.trunc(Number(rawArm?.partialRecoveries ?? 0) || 0)),
    recoveryTokensSaved: Math.max(0, Math.trunc(Number(rawArm?.recoveryTokensSaved ?? 0) || 0)),
    antiThrashingTriggered: Math.max(0, Math.trunc(Number(rawArm?.antiThrashingTriggered ?? 0) || 0)),
    decisions: {
      DIRECT: Math.max(0, Math.trunc(Number(decRaw.DIRECT ?? 0) || 0)),
      SUPPORTING: Math.max(0, Math.trunc(Number(decRaw.SUPPORTING ?? 0) || 0)),
      DEFER: Math.max(0, Math.trunc(Number(decRaw.DEFER ?? 0) || 0)),
      DUPLICATE: Math.max(0, Math.trunc(Number(decRaw.DUPLICATE ?? 0) || 0)),
      IRRELEVANT: Math.max(0, Math.trunc(Number(decRaw.IRRELEVANT ?? 0) || 0)),
    },
  };
}

/**
 * Reads the latest archived ACI ablation summary (`*-summary.json`) and its
 * companion Markdown/LaTeX tables from `evidenceDir` (default `backend/docs/evidence`).
 */
export function loadLatestAciAblationSummary({ evidenceDir = DEFAULT_ACI_EVIDENCE_DIR } = {}) {
  const dir = resolve(String(evidenceDir || DEFAULT_ACI_EVIDENCE_DIR));
  if (!existsSync(dir)) return { available: false };

  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return { available: false };
  }

  const candidates = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/^.+?-summary\.json$/i.test(entry.name)) continue;
    const summaryPath = join(dir, entry.name);
    try {
      const stat = statSync(summaryPath);
      const parsed = JSON.parse(readFileSync(summaryPath, 'utf8'));
      const byArm = parsed?.metrics?.byArm;
      if (!parsed || typeof parsed !== 'object' || !byArm || typeof byArm !== 'object') continue;
      const parsedTs = parsed.createdAt ? Date.parse(String(parsed.createdAt)) : NaN;
      const sortMs = Number.isFinite(parsedTs) ? parsedTs : stat.mtimeMs;
      candidates.push({
        name: entry.name,
        prefix: entry.name.replace(/-summary\.json$/i, ''),
        sortMs,
        mtimeMs: stat.mtimeMs,
        parsed,
      });
    } catch {
      // Skip malformed or unrelated summary files cleanly
    }
  }

  if (candidates.length === 0) return { available: false };

  candidates.sort((a, b) => b.sortMs - a.sortMs || b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));
  const latest = candidates[0];
  const { parsed, prefix, mtimeMs } = latest;
  const byArmRaw = parsed.metrics?.byArm ?? {};
  const rawArms =
    Array.isArray(parsed.arms) && parsed.arms.length > 0
      ? parsed.arms
      : Array.isArray(parsed.metrics?.arms) && parsed.metrics.arms.length > 0
        ? parsed.metrics.arms
        : Object.keys(byArmRaw);
  const armOrder = rawArms.filter((arm) => Object.hasOwn(byArmRaw, arm));
  const summaryByArm = {};
  for (const arm of armOrder) {
    summaryByArm[arm] = normalizeAblationArmSummary(arm, byArmRaw[arm], parsed.armProfiles);
  }

  const texPath = join(dir, `${prefix}-paper-tables.tex`);
  const mdPath = join(dir, `${prefix}-paper-tables.md`);
  let latexTable = '';
  let markdownTable = '';
  try {
    latexTable = existsSync(texPath) ? readFileSync(texPath, 'utf8') : exportPaperTablesLatex(parsed);
  } catch {
    latexTable = exportPaperTablesLatex(parsed);
  }
  try {
    markdownTable = existsSync(mdPath) ? readFileSync(mdPath, 'utf8') : exportPaperTablesMarkdown(parsed);
  } catch {
    markdownTable = exportPaperTablesMarkdown(parsed);
  }

  return {
    available: true,
    suite: String(parsed.suite ?? 'aci'),
    model:
      parsed.model != null
        ? String(parsed.model)
        : parsed.mode === 'deterministic'
          ? 'deterministic-probe'
          : null,
    mode: parsed.mode != null ? String(parsed.mode) : null,
    benchmarkId: parsed.benchmarkId != null ? String(parsed.benchmarkId) : null,
    createdAt: parsed.createdAt ? String(parsed.createdAt) : new Date(mtimeMs).toISOString(),
    archivePrefix: prefix,
    armOrder,
    summaryByArm,
    latexTable: redactSecrets(latexTable),
    markdownTable: redactSecrets(markdownTable),
  };
}

function hydrateEvaluationRun(run) {
  if (!run || typeof run !== 'object') return run ?? null;
  return {
    ...run,
    projectId: run.projectId ?? run.evaluationProjectId ?? null,
  };
}

function plainRun(record) {
  return hydrateEvaluationRun(structuredClone(record));
}

function safeError(error) {
  return redactSecrets(String(error?.message ?? error ?? 'evaluation failed')).slice(0, 1000);
}

function safeJson(value, fallback = null) {
  try {
    const text = redactSecrets(JSON.stringify(value ?? null));
    return text.length > 200_000 ? text.slice(0, 200_000) : text;
  } catch {
    return JSON.stringify(fallback);
  }
}

function parseJson(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function positiveAttemptLimit(value, fallback = 1) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function terminalEvaluationStatus(status) {
  return TERMINAL_EVALUATION_STATUSES.has(String(status));
}

function durableTaskId(runId, taskId) {
  return `${String(runId)}:${String(taskId)}`;
}

function isFullResultPass(result) {
  return Boolean(result && result.status === 'passed' && result.passed === true);
}

function hasEngineeringEvidence(result) {
  const ev = result?.judge?.evidence;
  return Boolean(
    ev &&
      (ev.implementationPassed !== undefined ||
        ev.testsPassed !== undefined ||
        ev.evidenceCompliant !== undefined),
  );
}

function isResultBudgetExhausted(result) {
  return Boolean(
    result?.errorCode === 'STEP_BUDGET_EXHAUSTED' ||
      result?.telemetry?.errorCode === 'STEP_BUDGET_EXHAUSTED' ||
      /STEP_BUDGET/i.test(String(result?.error ?? result?.judge?.reason ?? '')),
  );
}

function roundMetric4(value) {
  return Number(Math.max(0, Math.min(1, Number(value) || 0)).toFixed(4));
}

export function deriveLayeredCapabilities(results = [], score = {}) {
  const valid = results.filter(
    (r) => r?.taskId && ['passed', 'failed', 'timeout', 'cancelled'].includes(r.status),
  );
  const fullAcceptanceRate = Number(
    score?.passRate ?? (valid.length ? valid.filter(isFullResultPass).length / valid.length : 0),
  );
  const implOk = (r) => Boolean(r.judge?.evidence?.implementationPassed ?? isFullResultPass(r));
  const testOk = (r) =>
    Boolean(r.judge?.evidence?.testsPassed ?? r.judge?.evidence?.checks?.tests ?? isFullResultPass(r));
  const evidenceOk = (r) => Boolean(r.judge?.evidence?.evidenceCompliant ?? isFullResultPass(r));

  const implementationRate = valid.length ? valid.filter(implOk).length / valid.length : 0;
  const testPassRate = valid.length ? valid.filter(testOk).length / valid.length : 0;
  const evidenceComplianceRate = valid.length ? valid.filter(evidenceOk).length / valid.length : 0;
  const engineeringScore = roundMetric4(
    0.35 * implementationRate + 0.3 * testPassRate + 0.35 * fullAcceptanceRate,
  );

  const partialRate = (regex) => {
    const subset = valid.filter((r) => regex.test(String(r.taskId)));
    const pool = subset.length ? subset : valid;
    if (!pool.length) return 0;
    const sum = pool.reduce((acc, r) => {
      if (isFullResultPass(r)) return acc + 1;
      if (hasEngineeringEvidence(r)) {
        if (implOk(r) && testOk(r)) return acc + 0.65;
        if (implOk(r)) return acc + 0.35;
      }
      return acc;
    }, 0);
    return sum / pool.length;
  };

  const analysisAuditRate = partialRate(
    /code-generation|unfamiliar-codebase|real-security-audit|real-recovery|real-bug-fix|real-refactor|real-codebase-analysis|oss-/i,
  );
  const planningCompletionRate = partialRate(
    /multi-file-refactor|long-task-recovery|multi-agent|real-refactor|real-recovery|real-multi-agent|real-multi-file-feature|oss-/i,
  );
  const reasoningScore = roundMetric4(0.6 * analysisAuditRate + 0.4 * planningCompletionRate);

  const toolTotals = valid.reduce((s, r) => s + Number(r.telemetry?.toolReceiptCount ?? 0), 0);
  const toolSuccesses = valid.reduce((s, r) => s + Number(r.telemetry?.toolReceiptSuccessCount ?? 0), 0);
  const toolSuccessRate = toolTotals > 0
    ? Math.min(1, toolSuccesses / toolTotals)
    : valid.some(hasEngineeringEvidence)
      ? testPassRate
      : fullAcceptanceRate;
  const recoveryPool = valid.filter((r) => /recovery/i.test(String(r.taskId)));
  const recoveryRate = (recoveryPool.length ? recoveryPool : valid).length
    ? (recoveryPool.length ? recoveryPool : valid).reduce(
        (s, r) => s + (isFullResultPass(r) ? 1 : hasEngineeringEvidence(r) && implOk(r) ? 0.5 : 0),
        0,
      ) / (recoveryPool.length ? recoveryPool : valid).length
    : 0;
  const budgetCompletionRate = valid.length
    ? valid.filter((r) => !isResultBudgetExhausted(r)).length / valid.length
    : 0;
  const timeoutFreeRate = valid.length
    ? valid.filter((r) => r.status !== 'timeout').length / valid.length
    : 0;
  const executionScore = roundMetric4(
    0.45 * toolSuccessRate + 0.25 * recoveryRate + 0.15 * budgetCompletionRate + 0.15 * timeoutFreeRate,
  );

  const meanDurationMs = Number(
    score?.meanDurationMs ??
      (valid.length ? valid.reduce((sum, r) => sum + Number(r.durationMs || 0), 0) / valid.length : 0),
  );
  const stepSamples = valid.map((r) => Number(r.telemetry?.stepUsage?.steps ?? 0)).filter((s) => s > 0);
  const meanSteps = stepSamples.length
    ? stepSamples.reduce((a, b) => a + b, 0) / stepSamples.length
    : 0;
  const tokenSamples = valid
    .map((r) => {
      const tu = r.telemetry?.tokenUsage;
      if (!tu) return 0;
      return Number(tu.totalTokens ?? Number(tu.inputTokens ?? 0) + Number(tu.outputTokens ?? 0));
    })
    .filter((t) => t > 0);
  const meanTokens = tokenSamples.length
    ? tokenSamples.reduce((a, b) => a + b, 0) / tokenSamples.length
    : 0;
  const latencyScore = valid.length
    ? roundMetric4(Math.max(0.05, Math.min(1, 1 - meanDurationMs / 60_000)))
    : 0;
  const stepEfficiencyScore = meanSteps > 0
    ? roundMetric4(Math.max(0.1, Math.min(1, 1 - meanSteps / 48)))
    : roundMetric4(fullAcceptanceRate > 0 ? latencyScore : 0);
  const efficiencyGate = fullAcceptanceRate > 0 || implementationRate > 0 ? 1 : 0.25;
  const efficiencyScore = roundMetric4(
    valid.length ? (0.6 * latencyScore + 0.4 * stepEfficiencyScore) * efficiencyGate : 0,
  );

  return {
    sampleCount: valid.length,
    engineering: {
      implementationRate: roundMetric4(implementationRate),
      testPassRate: roundMetric4(testPassRate),
      evidenceComplianceRate: roundMetric4(evidenceComplianceRate),
      fullAcceptanceRate: roundMetric4(fullAcceptanceRate),
      score: engineeringScore,
    },
    reasoning: {
      analysisAuditRate: roundMetric4(analysisAuditRate),
      planningCompletionRate: roundMetric4(planningCompletionRate),
      score: reasoningScore,
    },
    execution: {
      toolSuccessRate: roundMetric4(toolSuccessRate),
      recoveryRate: roundMetric4(recoveryRate),
      budgetCompletionRate: roundMetric4(budgetCompletionRate),
      timeoutFreeRate: roundMetric4(timeoutFreeRate),
      score: executionScore,
    },
    efficiency: {
      meanDurationMs: Math.round(meanDurationMs),
      meanSteps: Number(meanSteps.toFixed(2)),
      meanTokens: Math.round(meanTokens),
      latencyScore,
      stepEfficiencyScore,
      score: efficiencyScore,
    },
  };
}

function deriveMeasuredCapabilities(results = [], score = {}) {
  const valid = results.filter((r) => r?.taskId && ['passed', 'failed', 'timeout', 'cancelled'].includes(r.status));
  const layered = deriveLayeredCapabilities(results, score);
  const partialFor = (regex) => {
    const subset = valid.filter((r) => regex.test(String(r.taskId)));
    const pool = subset.length ? subset : valid;
    if (!pool.length) return 0;
    const sum = pool.reduce((acc, r) => {
      if (isFullResultPass(r)) return acc + 1;
      if (hasEngineeringEvidence(r)) {
        const impl = Boolean(r.judge?.evidence?.implementationPassed);
        const test = Boolean(r.judge?.evidence?.testsPassed ?? r.judge?.evidence?.checks?.tests);
        if (impl && test) return acc + 0.65;
        if (impl) return acc + 0.35;
      }
      return acc;
    }, 0);
    return sum / pool.length;
  };
  const passRate = layered.engineering.fullAcceptanceRate;
  const implRate = layered.engineering.implementationRate;
  const activeSignal = Math.max(passRate, 0.65 * implRate);
  const speedBase = Math.max(0.05, Math.min(1, 1 - layered.efficiency.meanDurationMs / 60_000));
  const speed = Number(((activeSignal > 0 ? 0.2 : 0) + 0.8 * speedBase * Math.max(0.2, activeSignal)).toFixed(4));
  return {
    coding: roundMetric4(partialFor(/code-generation|multi-file-refactor|real-multi-file-feature|real-bug-fix|real-refactor|real-tests|real-api-compat|real-data-processing|real-recovery|real-multi-agent|oss-/i)),
    reasoning: roundMetric4(partialFor(/code-generation|unfamiliar-codebase|real-security-audit|real-recovery|real-bug-fix|real-refactor|oss-/i)),
    research: roundMetric4(partialFor(/unfamiliar-codebase|network-research|real-codebase-analysis|real-security-audit/i)),
    planning: roundMetric4(partialFor(/multi-file-refactor|long-task-recovery|multi-agent|real-refactor|real-recovery|real-multi-agent|oss-/i)),
    speed,
    contextCapacity: roundMetric4(valid.length ? 0.4 + 0.6 * activeSignal : 0),
    multimodal: 0,
    toolCompatibility: roundMetric4(Math.max(layered.execution.toolSuccessRate * (activeSignal > 0 ? 1 : 0.5), partialFor(/real-|multi-agent|recovery|oss-/i))),
  };
}

export function summarizeReasoningMetrics(results = []) {
  const items = Array.isArray(results) ? results : [];
  const withMetrics = [];
  for (const r of items) {
    const rm =
      r?.telemetry?.reasoningMetrics ??
      r?.output?.reasoningMetrics ??
      r?.judge?.evidence?.reasoningMetrics ??
      r?.reasoningMetrics ??
      null;
    if (rm && typeof rm === 'object') {
      withMetrics.push({ result: r, rm });
    }
  }

  let totalIneffectiveActions = 0;
  let ineffectiveSamples = 0;
  let firstFixEvaluated = 0;
  let firstFixSuccessCount = 0;
  let reproducedEvaluated = 0;
  let reproducedBeforeEditCount = 0;
  let selfCorrectionAttempts = 0;
  let selfCorrectionRecoveredCount = 0;
  let rootCauseReadEvaluated = 0;
  let rootCauseFilesReadCount = 0;
  let unverifiedMutationsAfterPassCount = 0;
  let totalFalsifiedAttempts = 0;
  const stuckTriggerCounts = {};
  const uniqueFingerprints = new Set();

  for (const { rm } of withMetrics) {
    if (rm.ineffectiveActionCount != null && Number.isFinite(Number(rm.ineffectiveActionCount))) {
      totalIneffectiveActions += Math.max(0, Number(rm.ineffectiveActionCount));
      ineffectiveSamples += 1;
    }
    if (typeof rm.firstFixSucceeded === 'boolean') {
      firstFixEvaluated += 1;
      if (rm.firstFixSucceeded) firstFixSuccessCount += 1;
    }
    if (typeof rm.reproducedFailureBeforeEdit === 'boolean') {
      reproducedEvaluated += 1;
      if (rm.reproducedFailureBeforeEdit) reproducedBeforeEditCount += 1;
    }
    const hadStuckOrFalsified =
      rm.selfCorrectionRecovered === true ||
      rm.circuitBroken === true ||
      Number(rm.stuckTriggerCount || 0) > 0 ||
      (Array.isArray(rm.stuckTriggers) && rm.stuckTriggers.length > 0) ||
      (Array.isArray(rm.stuckDetections) && rm.stuckDetections.length > 0) ||
      (Array.isArray(rm.falsifiedAttempts) && rm.falsifiedAttempts.length > 0);
    if (hadStuckOrFalsified) {
      selfCorrectionAttempts += 1;
      if (rm.selfCorrectionRecovered === true) selfCorrectionRecoveredCount += 1;
    }
    if (rm.rootCauseFilesReadBeforeEdit !== undefined && rm.rootCauseFilesReadBeforeEdit !== null) {
      rootCauseReadEvaluated += 1;
      if (
        rm.rootCauseFilesReadBeforeEdit === true ||
        (Array.isArray(rm.rootCauseFilesReadBeforeEdit) && rm.rootCauseFilesReadBeforeEdit.length > 0) ||
        Number(rm.rootCauseFilesReadBeforeEdit) > 0
      ) {
        rootCauseFilesReadCount += 1;
      }
    }
    if (rm.hasUnverifiedMutationsAfterLastPass === true) {
      unverifiedMutationsAfterPassCount += 1;
    }
    if (Array.isArray(rm.falsifiedAttempts)) {
      totalFalsifiedAttempts += rm.falsifiedAttempts.length;
    } else if (rm.falsifiedAttemptCount != null && Number.isFinite(Number(rm.falsifiedAttemptCount))) {
      totalFalsifiedAttempts += Math.max(0, Number(rm.falsifiedAttemptCount));
    }
    const triggerList = Array.isArray(rm.stuckTriggers)
      ? rm.stuckTriggers
      : Array.isArray(rm.stuckDetections)
        ? rm.stuckDetections
        : null;
    if (triggerList) {
      for (const trig of triggerList) {
        const key = typeof trig === 'string' ? trig : String(trig?.pattern ?? trig?.type ?? 'unknown');
        stuckTriggerCounts[key] = (stuckTriggerCounts[key] ?? 0) + 1;
      }
    } else if (rm.stuckPatternCounts && typeof rm.stuckPatternCounts === 'object') {
      for (const [k, v] of Object.entries(rm.stuckPatternCounts)) {
        stuckTriggerCounts[k] = (stuckTriggerCounts[k] ?? 0) + Math.max(0, Number(v || 0));
      }
    }
    if (Array.isArray(rm.errorFingerprints)) {
      for (const fp of rm.errorFingerprints) {
        const key = typeof fp === 'string' ? fp : fp?.signature ?? fp?.code ?? null;
        if (key) uniqueFingerprints.add(String(key));
      }
    }
  }

  const sampleCount = withMetrics.length;
  return {
    totalResults: items.length,
    sampleCount,
    totalIneffectiveActions,
    meanIneffectiveActions: ineffectiveSamples > 0 ? Number((totalIneffectiveActions / ineffectiveSamples).toFixed(4)) : 0,
    firstFixSuccessCount,
    firstFixSuccessRate: firstFixEvaluated > 0 ? roundMetric4(firstFixSuccessCount / firstFixEvaluated) : null,
    reproducedBeforeEditCount,
    reproducedBeforeEditRate: reproducedEvaluated > 0 ? roundMetric4(reproducedBeforeEditCount / reproducedEvaluated) : null,
    selfCorrectionAttempts,
    selfCorrectionRecoveredCount,
    selfCorrectionRecoveryRate: selfCorrectionAttempts > 0 ? roundMetric4(selfCorrectionRecoveredCount / selfCorrectionAttempts) : null,
    rootCauseFilesReadCount,
    rootCauseReadBeforeEditRate: rootCauseReadEvaluated > 0 ? roundMetric4(rootCauseFilesReadCount / rootCauseReadEvaluated) : null,
    unverifiedMutationsAfterPassCount,
    totalFalsifiedAttempts,
    stuckTriggerCounts,
    uniqueErrorFingerprintsCount: uniqueFingerprints.size,
  };
}

function extractCallCommandsFromMessages(db, sessionId, turnId) {
  const map = new Map();
  if (!db?.isOpen || !sessionId || !turnId) return map;
  try {
    const rows = db
      .prepare("SELECT toolCalls FROM direct_messages WHERE sessionId=? AND turnId=? AND role='assistant' AND toolCalls IS NOT NULL")
      .all(sessionId, turnId);
    for (const row of rows) {
      try {
        const calls = JSON.parse(row.toolCalls);
        if (!Array.isArray(calls)) continue;
        for (const tc of calls) {
          if (!tc?.id) continue;
          const args = typeof tc.arguments === 'string' ? JSON.parse(tc.arguments) : tc.arguments;
          if (typeof args?.command === 'string') map.set(tc.id, args.command);
        }
      } catch {
        // ignore malformed historical toolCalls
      }
    }
  } catch {
    // ignore in minimal DB mocks
  }
  return map;
}

function collectTurnTelemetry(directAgent, sessionId, turnId, currentTurn) {
  const db = directAgent?.store?.db;
  let toolReceipts = null;
  let parsedVerdict = parseJson(currentTurn?.verdict ?? currentTurn?.verdictJson, null);
  let reasoningMetrics = null;
  let stepUsage = currentTurn?.step != null ? { steps: Number(currentTurn.step) } : null;
  let tokenUsage = currentTurn?.inputTokens != null || currentTurn?.outputTokens != null
    ? {
        inputTokens: Number(currentTurn.inputTokens ?? 0),
        outputTokens: Number(currentTurn.outputTokens ?? 0),
        totalTokens: Number(currentTurn.inputTokens ?? 0) + Number(currentTurn.outputTokens ?? 0),
      }
    : null;
  if (db?.isOpen && sessionId && turnId) {
    try {
      const cmdMap = extractCallCommandsFromMessages(db, sessionId, turnId);
      const rawReceipts = db
        .prepare('SELECT id, sessionId, turnId, callId, toolName, status, exitCode, outputDigest, errorCode FROM tool_receipts WHERE sessionId=? AND turnId=? ORDER BY createdAt ASC')
        .all(sessionId, turnId);
      toolReceipts = rawReceipts.map((r) => ({ ...r, command: cmdMap.get(r.callId) ?? '' }));
      const turnRow = db.prepare('SELECT step, inputTokens, outputTokens, verdictJson FROM direct_turns WHERE id=?').get(turnId);
      if (turnRow) {
        if (turnRow.step != null) stepUsage = { steps: Number(turnRow.step) };
        tokenUsage = {
          inputTokens: Number(turnRow.inputTokens ?? 0),
          outputTokens: Number(turnRow.outputTokens ?? 0),
          totalTokens: Number(turnRow.inputTokens ?? 0) + Number(turnRow.outputTokens ?? 0),
        };
        if (!parsedVerdict && turnRow.verdictJson) {
          parsedVerdict = parseJson(turnRow.verdictJson, null);
        }
      }
      const termEvRow = db
        .prepare("SELECT data FROM direct_events WHERE sessionId=? AND turnId=? AND type IN ('turn/completed','turn/failed') ORDER BY seq DESC LIMIT 1")
        .get(sessionId, turnId);
      const termEvData = parseJson(termEvRow?.data, null);
      if (termEvData?.reasoningMetrics && typeof termEvData.reasoningMetrics === 'object') {
        reasoningMetrics = termEvData.reasoningMetrics;
      }
    } catch {
      // minimal store mock fallback
    }
  }
  return { toolReceipts, parsedVerdict, stepUsage, tokenUsage, reasoningMetrics };
}

function resolveTaskSandbox({
  baseSandbox = null,
  sandboxOptions = null,
  workspaceRoot = null,
  task = null,
} = {}) {
  const isolation = task?.metadata?.sandboxIsolation ?? {};
  const depPolicy = task?.metadata?.dependencyPolicy ?? DEFAULT_DEPENDENCY_POLICY;
  const allowCli =
    isolation.allowWorkspaceNodeCli !== undefined
      ? Boolean(isolation.allowWorkspaceNodeCli)
      : undefined;

  if (baseSandbox) {
    if (!(baseSandbox instanceof BenchmarkSandbox)) {
      return baseSandbox;
    }
    const needsWsOverride =
      Boolean(workspaceRoot) && baseSandbox.workspaceRoot !== workspaceRoot;
    const needsCliOverride =
      allowCli !== undefined && allowCli !== baseSandbox.allowWorkspaceNodeCli;
    const needsPolicyOverride =
      Boolean(task?.metadata?.dependencyPolicy) &&
      baseSandbox.dependencyPolicy !== task.metadata.dependencyPolicy;
    if (!needsWsOverride && !needsCliOverride && !needsPolicyOverride) {
      return baseSandbox;
    }
    return new BenchmarkSandbox({
      mode: baseSandbox.mode,
      allowProcessHardeningOnly: baseSandbox.allowProcessHardeningOnly,
      workspaceRoot: workspaceRoot ?? baseSandbox.workspaceRoot ?? null,
      dependencyPolicy: task?.metadata?.dependencyPolicy ?? baseSandbox.dependencyPolicy,
      dockerSandbox: baseSandbox.dockerSandbox,
      nodePermissionSandbox: baseSandbox.nodePermissionSandbox,
      allowWorkspaceNodeCli: allowCli ?? baseSandbox.allowWorkspaceNodeCli,
      timeoutMs: isolation.timeoutMs ?? baseSandbox.timeoutMs,
      cpuLimitSec:
        isolation.cpuLimitSec !== undefined ? isolation.cpuLimitSec : baseSandbox.cpuLimitSec,
      memoryLimitMb: isolation.memoryLimitMb ?? baseSandbox.memoryLimitMb,
      maxOutputBytes: baseSandbox.maxOutputBytes,
    });
  }

  return new BenchmarkSandbox({
    ...(sandboxOptions ?? {}),
    workspaceRoot: workspaceRoot ?? sandboxOptions?.workspaceRoot ?? null,
    dependencyPolicy: depPolicy,
    ...(allowCli !== undefined ? { allowWorkspaceNodeCli: allowCli } : {}),
    ...(isolation.timeoutMs !== undefined ? { timeoutMs: isolation.timeoutMs } : {}),
    ...(isolation.cpuLimitSec !== undefined ? { cpuLimitSec: isolation.cpuLimitSec } : {}),
    ...(isolation.memoryLimitMb !== undefined ? { memoryLimitMb: isolation.memoryLimitMb } : {}),
  });
}

function createDirectRuntimeAdapter(directAgent, { model = null, sandbox = null, sandboxOptions = null } = {}) {
  if (!directAgent) throw new TypeError('Evaluation requires DirectAgentRuntime');
  return ({ task, attempt = 1, workspaceRoot, signal, context = {} }) => {
    let turnId = null;
    const attemptId = `attempt-${Number(attempt || 1)}`;
    const planVersion = Number(task.metadata?.planVersion ?? 1);
    const evalPermissionMode =
      task.metadata?.requiresWorkspaceMutation === true ? 'full-access' : 'auto-safe';
    const isBenchmarkTask = Boolean(
      workspaceRoot ||
        task?.fixture ||
        task?.metadata?.acceptanceCriteria ||
        task?.metadata?.externalNetwork === false ||
        task?.metadata?.sandboxIsolation,
    );
    const evalToolDeny = isBenchmarkTask
      ? ['web_fetch', 'web_search', 'start_process']
      : task.metadata?.externalNetwork === false
        ? ['web_fetch', 'web_search']
        : null;
    const hasAcceptanceCriteria = Boolean(task.metadata?.acceptanceCriteria);
    const evidenceContract = hasAcceptanceCriteria
      ? {
          taskId: task.id,
          attemptId,
          planVersion,
          expectedTestCommand: task.metadata.acceptanceCriteria.testCommand,
          requiredChangedFiles: task.metadata.acceptanceCriteria.requiredChangedFiles,
          workspaceRoot,
          requireIndependentVerdict: false,
        }
      : null;
    const turnInput =
      hasAcceptanceCriteria && Number(attempt) > 1
        ? `${task.prompt}\n\n[Execution Binding] taskId=${task.id}, attemptId=${attemptId}, planVersion=${planVersion}`
        : task.prompt;
    const run = withTraceContext({ trafficSource: TRAFFIC_SOURCES.EVAL, isSynthetic: true }, async () => {
      let taskSandbox = null;
      if (isBenchmarkTask) {
        taskSandbox = resolveTaskSandbox({
          baseSandbox: context?.sandbox ?? sandbox ?? null,
          sandboxOptions: context?.sandboxOptions ?? sandboxOptions ?? null,
          workspaceRoot,
          task,
        });
        taskSandbox.resolveBackend();
      }
      const session = directAgent.createSession({
        title: `Evaluation · ${task.id}`,
        model: model || context.model || undefined,
        workspaceRoot,
        mode: 'direct',
        permissionMode: evalPermissionMode,
        ...(evalToolDeny ? { toolDeny: evalToolDeny } : {}),
        ...(taskSandbox ? { sandbox: taskSandbox, sandboxProfile: 'benchmark' } : {}),
        trafficSource: TRAFFIC_SOURCES.EVAL,
        isSynthetic: true,
      });
      const baseBudgetSteps = task.resourceBudget?.maxSteps ?? task.metadata?.resourceBudget?.maxSteps ?? 16;
      const resolvedModel = model || context.model || undefined;
      const histStats = directAgent?.store
        ? queryHistoricalTaskMetrics(directAgent.store, { taskType: task.id, model: resolvedModel })
        : null;
      const adaptiveBudget = histStats && histStats.sampleCount > 0 && hasAcceptanceCriteria
        ? estimateTaskBudget({
            taskType: task.id,
            fileCount: Object.keys(task.fixture?.files ?? {}).length || task.metadata?.repoFileCount || 1,
            requiredTools: ['read_file', 'write_file', 'edit_file', 'bash'],
            expectedArtifacts: task.metadata?.expectedArtifacts ?? [],
            verificationComplexity: /security-audit|recovery|multi-agent/.test(task.id) ? 'high' : 'medium',
            recoveryRequirements: /recovery/.test(task.id),
            historicalStats: histStats,
            userBudget: context.maxSteps ? { maxSteps: context.maxSteps } : {},
          })
        : null;
      const effectiveMaxSteps = adaptiveBudget
        ? Math.min(40, Math.max(baseBudgetSteps, adaptiveBudget.maxSteps))
        : baseBudgetSteps;
      const finalVerificationReserve =
        adaptiveBudget?.finalVerificationReserve ??
        task.resourceBudget?.finalVerificationReserve ??
        task.metadata?.resourceBudget?.finalVerificationReserve ??
        null;

      const started = directAgent.startTurn(session.id, {
        input: turnInput,
        model: resolvedModel,
        permissionMode: evalPermissionMode,
        maxSteps: effectiveMaxSteps,
        ...(finalVerificationReserve != null ? { finalVerificationReserve } : {}),
        ...(evidenceContract ? { evidenceContract } : {}),
        trafficSource: TRAFFIC_SOURCES.EVAL,
        isSynthetic: true,
      });
      turnId = started?.turn?.id;
      if (!turnId) throw new Error('DirectAgentRuntime did not create an evaluation turn');
      const cancel = () => { try { directAgent.cancelTurn(turnId); } catch { /* durable runtime records cancellation */ } };
      signal?.addEventListener('abort', cancel, { once: true });
      try {
        while (true) {
          if (signal?.aborted) {
            cancel();
            try { await directAgent.waitForTurnTerminal?.(turnId, { timeoutMs: 5_000 }); } catch { /* runner records drain state */ }
            const error = new Error('Evaluation cancelled'); error.name = 'AbortError'; error.code = 'E_EVAL_CANCELLED'; throw error;
          }
          const current = directAgent.listTurns(session.id, { limit: 20 }).find((turn) => turn.id === turnId);
          if (current && TERMINAL_TURN_STATES.has(current.state)) {
            const messages = directAgent.listMessages(session.id, { after: 0, limit: 500 });
            const text = messages.filter((message) => message.turnId === turnId && message.role === 'assistant').map((message) => String(message.content ?? '')).filter(Boolean).join('\n');
            const telemetry = collectTurnTelemetry(directAgent, session.id, turnId, current);
            const shellReceipts = Array.isArray(telemetry.toolReceipts)
              ? telemetry.toolReceipts.filter((r) => ['bash', 'start_process'].includes(String(r.toolName)))
              : [];
            const latestShell = shellReceipts.at(-1) ?? null;
            const shellHealthy =
              shellReceipts.length === 0 ||
              (latestShell?.status === 'finished' && (latestShell.exitCode == null || Number(latestShell.exitCode) === 0));
            const serverPassed =
              current.state === 'completed' &&
              (!telemetry.parsedVerdict || (telemetry.parsedVerdict.verdict === 'pass' && telemetry.parsedVerdict.accepted !== false)) &&
              Number(telemetry.parsedVerdict?.checks?.pendingReconciliations ?? 0) === 0 &&
              shellHealthy;
            const evidenceRefs = [
              `turn:${session.id}:${turnId}`,
              ...(Array.isArray(telemetry.toolReceipts) ? telemetry.toolReceipts.map((r) => `receipt:${r.id}`) : []),
            ];
            const trustedVerdict = serverPassed
              ? { status: 'pass', source: 'trusted_server_verifier', evidenceRefs }
              : { status: 'fail', source: 'trusted_server_verifier', evidenceRefs, reasons: telemetry.parsedVerdict?.reasons ?? [current.error || current.state] };

            const isSoftEvidenceFailure =
              current.state === 'failed' &&
              (telemetry.parsedVerdict?.status === 'EVIDENCE_INCOMPLETE' ||
                /EVIDENCE_INCOMPLETE|VERIFICATION_FAILED/i.test(String(current.error ?? '')));

            if (current.state !== 'completed' && !isSoftEvidenceFailure) {
              const error = new Error(current.error || `Evaluation turn ${current.state}`);
              error.code = current.state === 'cancelled'
                ? 'E_EVAL_CANCELLED'
                : /STEP_BUDGET/i.test(String(current.error ?? ''))
                  ? 'STEP_BUDGET_EXHAUSTED'
                  : 'E_RUNTIME_TURN_FAILED';
              if (current.state === 'cancelled') error.name = 'AbortError';
              error.telemetry = {
                attemptId,
                planVersion,
                runtimeStatus: current.state,
                errorCode: error.code,
                stepUsage: telemetry.stepUsage,
                tokenUsage: telemetry.tokenUsage,
                toolReceiptCount: telemetry.toolReceipts?.length ?? 0,
                trustedVerdict,
                ...(telemetry.reasoningMetrics ? { reasoningMetrics: telemetry.reasoningMetrics } : {}),
              };
              throw error;
            }
            return {
              output: text,
              sessionId: session.id,
              turnId,
              attemptId,
              planVersion,
              turnState: current.state,
              verdict: telemetry.parsedVerdict ?? current.verdict ?? null,
              evidenceCount: Number(current.evidenceCount ?? 0),
              toolReceipts: telemetry.toolReceipts,
              trustedVerdict,
              stepUsage: telemetry.stepUsage,
              tokenUsage: telemetry.tokenUsage,
              ...(telemetry.reasoningMetrics ? { reasoningMetrics: telemetry.reasoningMetrics } : {}),
            };
          }
          await delay(100, undefined, { signal });
        }
      } finally { signal?.removeEventListener('abort', cancel); }
    });
    return { run: () => run, waitForStop: async ({ reason = 'cancelled' } = {}) => { if (!turnId) return { drained: true, error: null }; try { await directAgent.waitForTurnTerminal?.(turnId, { timeoutMs: 5_000 }); return { drained: true, reason }; } catch (error) { return { drained: false, error: safeError(error) }; } } };
  };
}

export class EvaluationService {
  #controllers = new Map();
  #activeExecutions = new Map();

  constructor({ store, directAgent, runtimeFactory = null, jobQueue = null, judge = null, maxConcurrency = 2, timeoutMs = 120_000, memory = null, capabilityRegistry = null, ossCacheDir = null, ossRepoOverrides = null, sandbox = null, sandboxOptions = null, aciEvidenceDir = null } = {}) {
    if (!store || typeof store.add !== 'function' || typeof store.list !== 'function') {
      throw new TypeError('EvaluationService requires Store');
    }
    this.store = store;
    this.directAgent = directAgent ?? null;
    this.ossCacheDir = ossCacheDir ? String(ossCacheDir) : null;
    this.ossRepoOverrides = ossRepoOverrides && typeof ossRepoOverrides === 'object' ? ossRepoOverrides : null;
    this.aciEvidenceDir = aciEvidenceDir ? resolve(String(aciEvidenceDir)) : DEFAULT_ACI_EVIDENCE_DIR;
    this.sandbox = sandbox ?? null;
    this.sandboxOptions = sandboxOptions && typeof sandboxOptions === 'object' ? sandboxOptions : null;
    const datasetSandboxOpts = {
      ...(this.sandbox ? { sandbox: this.sandbox } : {}),
      ...(this.sandboxOptions ? { sandboxOptions: this.sandboxOptions } : {}),
    };
    this.registry = new EvaluationRegistry([
      ...createBenchmarkDataset(),
      ...createRealEngineeringDataset(datasetSandboxOpts),
      ...createOssBenchmarkDataset({
        repoOverrides: this.ossRepoOverrides,
        ...datasetSandboxOpts,
      }),
    ]);
    this.runtimeFactory = runtimeFactory;
    this.jobQueue = jobQueue;
    this.judge = typeof judge === 'function' ? judge : null;
    this.memory = memory;
    this.capabilityRegistry = capabilityRegistry;
    this.maxConcurrency = Math.min(4, Math.max(1, Number(maxConcurrency) || 2));
    this.timeoutMs = Math.min(600_000, Math.max(1_000, Number(timeoutMs) || 120_000));
  }

  async createTaskWorkspace(task, options = {}) {
    const resolvedCacheDir = options.cacheDir ?? this.ossCacheDir ?? task?.fixture?.cacheDir ?? null;
    const sbxOpts = {
      ...options,
      ...(this.sandbox && !options.sandbox ? { sandbox: this.sandbox } : {}),
      ...(this.sandboxOptions && !options.sandboxOptions ? { sandboxOptions: this.sandboxOptions } : {}),
    };
    if (task?.fixture?.repoUrl && task?.fixture?.commit) {
      return createGitRepoWorkspace(task, { ...sbxOpts, cacheDir: resolvedCacheDir });
    }
    return createFixtureWorkspace(task, sbxOpts);
  }

  registerOnWorker(recoveryWorker) {
    recoveryWorker?.registerHandler?.('evaluation_run', (job) => {
      const runId = String(job.taskId || job.payload?.runId || '');
      const run = this.getRun(runId);
      if (!run || ['completed', 'failed', 'cancelled', 'timeout'].includes(run.status)) return { skipped: true };
      const controller = this.#controllers.get(runId) ?? new AbortController();
      this.#controllers.set(runId, controller);
      const durableTasks = this.#listDurableTasks(runId);
      const durableByTask = new Map(durableTasks.map((task) => [String(task.taskId), task]));
      const taskPlans = (run.taskIds ?? []).map((id) => {
        const taskId = String(id);
        const durable = durableByTask.get(taskId);
        const evaluationTaskId = durable?.id ?? durableTaskId(runId, taskId);
        const attemptRow = this.store.db.prepare(`
          SELECT MAX(attempt) AS maxAttempt
          FROM evaluation_attempts
          WHERE evaluationTaskId=?
        `).get(evaluationTaskId);
        const existingAttempts = Math.max(
          Number(durable?.attempts ?? 0),
          Number(attemptRow?.maxAttempt ?? 0),
        );
        const maxAttempts = positiveAttemptLimit(
          durable?.maxAttempts,
          positiveAttemptLimit(run.options?.maxAttempts, 1),
        );
        const storedResult = terminalEvaluationStatus(durable?.status)
          ? parseJson(durable?.resultJson)
          : null;
        const task = this.registry.require(taskId);

        // A passed durable task is authoritative. It is deliberately excluded
        // from the recovery queue, even when the process died before the run
        // row was updated with its result.
        if (durable?.status === 'passed') {
          return { taskId, durable, storedResult, task, runnable: false };
        }

        // Timeout and cancellation are terminal task outcomes in the runner;
        // they must not be silently retried by a worker restart. Ordinary
        // failures may still have remaining attempts.
        if (durable?.status === 'timeout' || durable?.status === 'cancelled') {
          return { taskId, durable, storedResult, task, runnable: false };
        }

        const remainingAttempts = Math.max(0, maxAttempts - existingAttempts);
        if (remainingAttempts === 0) {
          return { taskId, durable, storedResult, task, runnable: false, exhausted: true };
        }
        return {
          taskId,
          durable,
          storedResult,
          task: {
            ...task,
            // EvaluationRunner treats maxAttempts as the number of attempts
            // available in this execution. The offset keeps attempt IDs
            // monotonic while the remaining count enforces the durable cap.
            maxAttempts: remainingAttempts,
            attemptOffset: existingAttempts,
          },
          runnable: true,
        };
      });
      const tasks = taskPlans.filter((plan) => plan.runnable).map((plan) => plan.task);
      const recoveredResults = taskPlans
        .filter((plan) => plan.storedResult)
        .map((plan) => plan.storedResult);
      if (recoveredResults.length) {
        const merged = this.#mergeResults(runId, recoveredResults);
        this.#update(runId, { results: merged, score: scoreResults(merged) });
      }
      if (!tasks.length) {
        const latest = this.getRun(runId);
        const results = this.#mergeResults(runId, latest?.results ?? []);
        const complete = (run.taskIds ?? []).every((id) => results.some((result) => String(result.taskId) === String(id)));
        this.#update(runId, {
          status: complete ? 'completed' : 'failed',
          finishedAt: Date.now(),
          score: scoreResults(results),
          results,
          error: complete ? null : 'evaluation recovery has no durable result for an exhausted task',
        });
        return { skipped: true, completed: true };
      }
      const execution = this.execute(runId, tasks, run.options ?? {}, controller);
      this.#activeExecutions.set(runId, execution);
      void execution.then(() => {}, () => {}).finally(() => this.#activeExecutions.delete(runId));
      return execution;
    });
    recoveryWorker?.wake?.();
  }

  listBenchmarks() {
    const datasetSandboxOpts = {
      ...(this.sandbox ? { sandbox: this.sandbox } : {}),
      ...(this.sandboxOptions ? { sandboxOptions: this.sandboxOptions } : {}),
    };
    const benchmarks = [
      {
        id: BENCHMARK_ID,
        title: 'Agent_US Deterministic Core Benchmark',
        version: BENCHMARK_VERSION,
        datasetVersion: DATASET_VERSION,
        tasks: createBenchmarkDataset(),
        description: 'Local deterministic smoke tasks. No network snapshots are used.',
      },
      {
        id: REAL_ENGINEERING_BENCHMARK_ID,
        title: 'Agent_US Real Software Engineering Benchmark',
        version: REAL_ENGINEERING_BENCHMARK_VERSION,
        datasetVersion: REAL_ENGINEERING_DATASET_VERSION,
        tasks: createRealEngineeringDataset(datasetSandboxOpts),
        description: 'Isolated multi-file engineering fixtures with real file edits, tests, Git diff evidence, and deterministic independent verification.',
      },
      {
        id: OSS_BENCHMARK_ID,
        title: 'Agent_US Open-Source Pinned-Commit Benchmark',
        version: OSS_BENCHMARK_VERSION,
        datasetVersion: OSS_DATASET_VERSION,
        tasks: createOssBenchmarkDataset({
          repoOverrides: this.ossRepoOverrides,
          ...datasetSandboxOpts,
        }),
        description: 'Real open-source GitHub repositories pinned to immutable commit SHAs with multi-commit git baseline tracking, baseline regression suites, and hidden behavioral judges.',
      },
    ];
    return benchmarks.map(({ tasks, ...benchmark }) => ({
      ...benchmark,
      taskCount: tasks.length,
      categories: [...new Set(tasks.map((task) => task.category))],
      tasks: tasks.map(({ id, title, category, difficulty, tags }) => ({ id, title, category, difficulty, tags })),
    }));
  }

  listRuns({ benchmarkId = null, limit = 50 } = {}) {
    const rows = this.store.list('evaluation_runs', { limit: Math.min(200, Math.max(1, Number(limit) || 50)) });
    return rows
      .map(hydrateEvaluationRun)
      .filter((run) => !benchmarkId || run.benchmarkId === benchmarkId)
      .sort((a, b) => Number(b.createdAt) - Number(a.createdAt));
  }

  getRun(id) {
    return hydrateEvaluationRun(this.store.get('evaluation_runs', String(id)));
  }

  getAciAblationSummary({ evidenceDir = this.aciEvidenceDir } = {}) {
    return loadLatestAciAblationSummary({ evidenceDir });
  }

  start({ benchmarkId = BENCHMARK_ID, taskIds = null, model = null, projectId = null, concurrency = this.maxConcurrency, timeoutMs = this.timeoutMs, maxAttempts = 1 } = {}) {
    const benchmark = this.listBenchmarks().find((item) => item.id === benchmarkId);
    if (!benchmark) {
      const error = new Error('Unknown benchmark');
      error.code = 'E_BENCHMARK_NOT_FOUND';
      error.status = 404;
      throw error;
    }
    if (!this.directAgent && !this.runtimeFactory) {
      const error = new Error('DirectAgentRuntime is unavailable');
      error.code = 'E_EVALUATION_RUNTIME_UNAVAILABLE';
      error.status = 503;
      throw error;
    }
    if (taskIds !== null && (!Array.isArray(taskIds) || taskIds.length < 1 || taskIds.length > 30)) {
      const error = new Error('taskIds must contain between 1 and 30 task IDs');
      error.code = 'E_EVALUATION_INVALID_REQUEST';
      error.status = 400;
      throw error;
    }
    const benchmarkTaskIds = new Set(benchmark.tasks.map((task) => task.id));
    const selectedTaskIds = taskIds ?? [...benchmarkTaskIds];
    if (selectedTaskIds.some((id) => !benchmarkTaskIds.has(String(id)))) {
      const error = new Error('taskIds must belong to the selected benchmark');
      error.code = 'E_EVALUATION_TASK_NOT_IN_BENCHMARK';
      error.status = 400;
      throw error;
    }
    const tasks = selectedTaskIds.map((id) => this.registry.require(String(id)));
    const runId = randomUUID();
    const now = Date.now();
    const resolvedProjectId = String(projectId ?? benchmarkId).slice(0, 500);
    const run = this.store.add('evaluation_runs', {
      id: runId,
      benchmarkId,
      benchmarkVersion: benchmark.version,
      datasetVersion: benchmark.datasetVersion,
      status: 'queued',
      model: model ? String(model).slice(0, 200) : null,
      projectId: resolvedProjectId,
      evaluationProjectId: resolvedProjectId,
      agentVersion: process.env.AGENT_US_VERSION || 'unknown',
      createdAt: now,
      startedAt: null,
      finishedAt: null,
      score: null,
      results: [],
      error: null,
      taskIds: tasks.map((task) => task.id),
      synthetic: true,
      options: { model, concurrency, timeoutMs, maxAttempts },
    }, null, null, runId);
    const controller = new AbortController();
    this.#controllers.set(run.id, controller);
    const options = { model, concurrency, timeoutMs, maxAttempts };
    this.#update(run.id, { options });
    this.#ensureDurableRun(this.getRun(run.id), tasks, options);
    if (this.jobQueue?.enqueue) {
      let queued = null;
      try {
        queued = this.jobQueue.enqueue({ kind: 'evaluation_run', taskId: run.id, payload: { runId: run.id }, idempotencyKey: `evaluation:${run.id}`, maxAttempts: 3 });
      } catch (error) {
        this.#update(run.id, { status: 'failed', finishedAt: Date.now(), error: safeError(error), errorCode: 'E_EVALUATION_ENQUEUE_FAILED' });
      }
      if (!queued && this.getRun(run.id).status === 'queued') {
        const execution = this.execute(run.id, tasks, options, controller);
        this.#activeExecutions.set(run.id, execution);
        void execution.then(() => {}, () => {}).finally(() => this.#activeExecutions.delete(run.id));
      }
    } else {
      const execution = this.execute(run.id, tasks, options, controller);
      this.#activeExecutions.set(run.id, execution);
      void execution.then(() => {}, () => {}).finally(() => this.#activeExecutions.delete(run.id));
    }
    return plainRun(run);
  }

  cancel(id) {
    const key = String(id);
    const run = this.getRun(key);
    if (!run || ['completed', 'failed', 'cancelled', 'timeout'].includes(run.status)) return run ?? null;
    const controller = this.#controllers.get(key);
    controller?.abort('cancelled by user');
    this.jobQueue?.cancelByTask?.(key);
    if (run.status === 'queued') return this.#update(key, { status: 'cancelled', finishedAt: Date.now() });
    return this.#update(key, { cancelRequestedAt: Date.now() });
  }

  async execute(runId, tasks, options, controller) {
    try {
      this.#update(runId, { status: 'running', startedAt: Date.now() });
      const run = this.getRun(runId);
      const recorder = new EvaluationRecorder({
        persist: async (result) => {
          const latest = this.getRun(runId);
          this.#update(runId, { results: [...(latest.results ?? []), result] });
        },
      });
      this.#ensureDurableRun(run, tasks, options);
      const runtimeFactory =
        this.runtimeFactory ??
        createDirectRuntimeAdapter(this.directAgent, {
          model: options.model,
          ...(this.sandbox ? { sandbox: this.sandbox } : {}),
          ...(this.sandboxOptions ? { sandboxOptions: this.sandboxOptions } : {}),
        });
      const runner = new EvaluationRunner({
        runtimeFactory,
        ...(this.judge ? { judge: this.judge } : {}),
        recorder,
        concurrency: Math.min(this.maxConcurrency, Math.max(1, Number(options.concurrency) || this.maxConcurrency)),
        timeoutMs: Math.min(this.timeoutMs, Math.max(1_000, Number(options.timeoutMs) || this.timeoutMs)),
        maxAttempts: Math.min(3, Math.max(1, Number(options.maxAttempts) || 1)),
        budget: { maxConcurrent: this.maxConcurrency, maxTasks: tasks.length },
        lifecycle: {
          onAttemptStart: async ({ task, attempt, workspaceRoot }) => {
            this.#recordAttemptStart(runId, task, attempt, workspaceRoot);
          },
          onAttemptEnd: async ({ task, attempt, workspaceRoot, result }) => {
            this.#recordAttemptEnd(runId, task, attempt, workspaceRoot, result);
          },
        },
        syntheticContextHook: async () => ({
          trafficSource: TRAFFIC_SOURCES.EVAL,
          isSynthetic: true,
          benchmarkId: run.benchmarkId,
          evaluationRunId: run.id,
        }),
      });
      const preparedTasks = tasks.map((task) => {
        const resolvedCacheDir = options.cacheDir ?? this.ossCacheDir ?? task?.fixture?.cacheDir ?? null;
        if (task?.fixture?.repoUrl && task?.fixture?.commit && resolvedCacheDir && !task.fixture.cacheDir) {
          return { ...task, fixture: { ...task.fixture, cacheDir: resolvedCacheDir } };
        }
        return task;
      });
      const runnerContext = {
        model: options.model,
        runId,
        ...(this.sandbox ? { sandbox: this.sandbox } : {}),
        ...(this.sandboxOptions ? { sandboxOptions: this.sandboxOptions } : {}),
      };
      const report = await runner.run({ tasks: preparedTasks, signal: controller.signal, context: runnerContext });
      const previousResults = Array.isArray(run.results) ? run.results : [];
      const mergedByTask = new Map(previousResults.map((result) => [String(result.taskId), result]));
      for (const result of report.results) mergedByTask.set(String(result.taskId), result);
      const mergedResults = [...mergedByTask.values()];
      const mergedReport = { ...report, results: mergedResults, score: scoreResults(mergedResults) };
      const terminalStatus = controller.signal.aborted
        ? 'cancelled'
        : report.results.some((result) => result.status === 'timeout') && mergedReport.results.every((result) => result.status === 'timeout' || result.status === 'cancelled')
          ? 'timeout'
          : 'completed';
      this.#update(runId, {
        status: terminalStatus,
        finishedAt: Date.now(),
        score: mergedReport.score,
        results: mergedReport.results,
        error: null,
      });
      const finalRun = this.getRun(runId);
      this.#recordTrustedOutcomes(finalRun, mergedReport, preparedTasks);
      if (finalRun.model && finalRun.status === 'completed' && mergedReport.score?.total > 0) {
        try {
          const measuredCaps = deriveMeasuredCapabilities(mergedReport.results, mergedReport.score);
          const layered = deriveLayeredCapabilities(mergedReport.results, mergedReport.score);
          const avgLatencyMs = Math.round(Number(mergedReport.score.meanDurationMs ?? 0));
          const evidenceRefs = mergedReport.results
            .filter((result) => result?.taskId && ['passed', 'failed', 'timeout', 'cancelled'].includes(result.status))
            .map((result) => `evaluation:${finalRun.id}:${result.taskId}`);
          if (evidenceRefs.length > 0) {
            this.capabilityRegistry?.recordMeasuredFromEvaluation?.(
              {
                id: finalRun.model,
                capabilities: measuredCaps,
                layered,
                metrics: {
                  passRate: mergedReport.score.passRate,
                  passed: mergedReport.score.passed,
                  failed: mergedReport.score.failed,
                  total: mergedReport.score.total,
                  avgLatencyMs,
                  implementationRate: layered.engineering.implementationRate,
                  testPassRate: layered.engineering.testPassRate,
                  evidenceComplianceRate: layered.engineering.evidenceComplianceRate,
                },
              },
              {
                evaluationRunId: finalRun.id,
                evidenceRefs,
                taskIds: mergedReport.results.map((result) => result.taskId),
              },
            );
          }
        } catch {
          // Capability updates are advisory and cannot alter the durable evaluation result.
        }
      }
    } catch (error) {
      this.#update(runId, {
        status: controller.signal.aborted ? 'cancelled' : 'failed',
        finishedAt: Date.now(),
        error: safeError(error),
      });
    } finally {
      this.#controllers.delete(runId);
    }
  }

  #update(id, patch) {
    const current = this.store.get('evaluation_runs', id);
    return this.store.update('evaluation_runs', current, patch);
  }

  #mergeResults(runId, incomingResults = []) {
    const run = this.getRun(runId);
    const mergedByTask = new Map();
    for (const result of Array.isArray(run?.results) ? run.results : []) {
      if (result?.taskId) mergedByTask.set(String(result.taskId), result);
    }
    for (const result of Array.isArray(incomingResults) ? incomingResults : []) {
      if (result?.taskId) mergedByTask.set(String(result.taskId), result);
    }
    const order = Array.isArray(run?.taskIds) ? run.taskIds.map(String) : [];
    return [
      ...order.filter((taskId) => mergedByTask.has(taskId)).map((taskId) => mergedByTask.get(taskId)),
      ...[...mergedByTask.entries()]
        .filter(([taskId]) => !order.includes(taskId))
        .map(([, result]) => result),
    ];
  }

  #listDurableTasks(runId) {
    return this.store.db.prepare('SELECT * FROM evaluation_tasks WHERE runId=? ORDER BY createdAt ASC').all(String(runId));
  }

  #ensureDurableRun(run, tasks, options) {
    const now = Date.now();
    this.store.tx(() => {
      this.store.db.prepare(`INSERT OR IGNORE INTO evaluation_budgets(runId,maxTasks,maxAttempts,maxConcurrent,maxDurationMs,createdAt,updatedAt)
        VALUES(?,?,?,?,?,?,?)`).run(run.id, tasks.length, options.maxAttempts, options.concurrency, options.timeoutMs, now, now);
      for (const task of tasks) {
        this.store.db.prepare(`INSERT OR IGNORE INTO evaluation_tasks
          (id,runId,taskId,status,attempts,maxAttempts,createdAt,updatedAt)
          VALUES(?,?,?,'queued',0,?,?,?)`).run(durableTaskId(run.id, task.id), run.id, task.id, task.maxAttempts ?? options.maxAttempts, now, now);
      }
    });
  }

  #recordAttemptStart(runId, task, attempt, workspaceRoot) {
    const taskId = durableTaskId(runId, task.id);
    const now = Date.now();
    this.store.tx(() => {
      this.store.db.prepare(`UPDATE evaluation_tasks SET status='running', attempts=?, workspaceRoot=?, startedAt=COALESCE(startedAt,?), updatedAt=? WHERE id=?`)
        .run(attempt, workspaceRoot, now, now, taskId);
      this.store.db.prepare(`INSERT OR IGNORE INTO evaluation_attempts
        (id,evaluationTaskId,attempt,status,workspaceRoot,startedAt)
        VALUES(?,?,?,'running',?,?)`).run(`${taskId}:attempt:${attempt}`, taskId, attempt, workspaceRoot, now);
      this.store.db.prepare(`INSERT OR REPLACE INTO evaluation_checkpoints(id,evaluationTaskId,attempt,phase,stateJson,createdAt)
        VALUES(?,?,?,?,?,?)`).run(`${taskId}:checkpoint:${attempt}`, taskId, attempt, 'started', JSON.stringify({ workspaceRoot }), now);
    });
  }

  #recordAttemptEnd(runId, task, attempt, workspaceRoot, result) {
    const taskId = durableTaskId(runId, task.id);
    const status = String(result.status);
    const now = Date.now();
    const output = result.output ?? null;
    const judge = result.judge ?? null;
    const artifacts = Array.isArray(output?.artifacts) ? output.artifacts : [];
    this.store.tx(() => {
      this.store.db.prepare(`UPDATE evaluation_tasks SET status=?, finishedAt=?, resultJson=?, errorCode=?, errorMessage=?, updatedAt=? WHERE id=?`)
        .run(status, now, safeJson(result), result.error?.code ?? null, safeError(result.error ?? result.errorMessage ?? ''), now, taskId);
      this.store.db.prepare(`UPDATE evaluation_attempts SET status=?, finishedAt=?, resultJson=?, runtimeSessionId=?, runtimeTurnId=?, errorCode=?, errorMessage=? WHERE evaluationTaskId=? AND attempt=?`)
        .run(status, now, safeJson(result), output?.sessionId ?? null, output?.turnId ?? null, result.error?.code ?? null, safeError(result.error ?? result.errorMessage ?? ''), taskId, attempt);
      this.store.db.prepare(`INSERT OR REPLACE INTO evaluation_checkpoints(id,evaluationTaskId,attempt,phase,stateJson,createdAt)
        VALUES(?,?,?,?,?,?)`).run(`${taskId}:checkpoint:${attempt}`, taskId, attempt, status, safeJson({ status, workspaceRoot, runtimeDrained: result.metadata?.runtimeDrained ?? null }), now);
      if (judge) this.store.db.prepare(`INSERT OR REPLACE INTO evaluation_judgements(id,evaluationTaskId,attempt,judgeType,rubricVersion,passed,confidence,evidenceJson,rationale,createdAt)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(`${taskId}:judgement:${attempt}`, taskId, attempt, judge.deterministic ? 'deterministic' : 'model', judge.rubricVersion ?? null, judge.passed == null ? null : (judge.passed ? 1 : 0), judge.confidence ?? null, safeJson(judge.evidence ?? judge), String(judge.reason ?? '').slice(0, 2000), now);
      for (let index = 0; index < artifacts.length; index += 1) {
        const artifact = artifacts[index];
        this.store.db.prepare(`INSERT OR REPLACE INTO evaluation_artifacts(id,evaluationTaskId,attempt,kind,sha256,manifestJson,contentJson,createdAt)
          VALUES(?,?,?,?,?,?,?,?)`).run(`${taskId}:artifact:${attempt}:${index}`, taskId, attempt, String(artifact.kind ?? 'result'), artifact.sha256 ?? null, safeJson(artifact.manifest ?? null), safeJson(artifact.content ?? null), now);
      }
    });
  }

  summarizeReasoningMetrics(results = []) {
    return summarizeReasoningMetrics(results);
  }

  #recordTrustedOutcomes(run, report, tasks = []) {
    if (!this.memory) return;
    const verifier = typeof this.memory.createTrustedVerifier === 'function'
      ? this.memory.createTrustedVerifier()
      : null;
    const runProjectId = run.projectId ?? run.evaluationProjectId ?? run.benchmarkId;
    const taskById = new Map((Array.isArray(tasks) ? tasks : []).map((t) => [String(t.id), t]));

    for (const result of report?.results ?? []) {
      const task = taskById.get(String(result.taskId)) ?? this.registry?.get?.(String(result.taskId)) ?? null;
      const taskInput = task?.prompt || task?.title || `Evaluation task ${result.taskId}`;
      const modifiedFiles = [
        ...(Array.isArray(result.judge?.evidence?.actualChangedFiles) ? result.judge.evidence.actualChangedFiles : []),
        ...(Array.isArray(result.output?.modifiedFiles) ? result.output.modifiedFiles : []),
        ...(Array.isArray(result.output?.changedFiles) ? result.output.changedFiles : []),
        ...(Array.isArray(task?.metadata?.acceptanceCriteria?.requiredChangedFiles) ? task.metadata.acceptanceCriteria.requiredChangedFiles : []),
      ];
      const toolReceipts = Array.isArray(result.output?.toolReceipts) ? result.output.toolReceipts : [];
      const reasoningMetrics = result.telemetry?.reasoningMetrics ?? result.output?.reasoningMetrics ?? null;

      if (result.status === 'passed' && result.passed === true) {
        if (run.status !== 'completed' || !result.judge?.deterministic) continue;
        let distilled = [];
        try {
          if (typeof this.memory.distillTurnExperience === 'function') {
            distilled = this.memory.distillTurnExperience({
              projectId: runProjectId,
              input: taskInput,
              summary: result.judge?.reason || (typeof result.output?.output === 'string' ? result.output.output : JSON.stringify(result.output?.output ?? 'passed')),
              workspaceRoot: null,
              verdict: {
                verdict: 'pass',
                accepted: true,
                reason: result.judge?.reason ?? 'deterministic_pass',
                checks: result.judge?.evidence?.checks ?? {},
              },
              reasoningMetrics,
              toolReceipts,
              modifiedFiles,
              evaluationEvidence: null,
              source: 'evaluation',
              sourceTaskId: result.taskId,
              sessionId: result.output?.sessionId ?? null,
              turnId: result.output?.turnId ?? null,
              runId: run.id,
            });
          } else {
            distilled = this.memory.remember({
              projectId: runProjectId,
              type: 'lesson',
              memoryClass: 'verified_fix_pattern',
              content: `Evaluation task ${result.taskId} passed deterministic verification.`,
              source: 'evaluation',
            }, { projectId: runProjectId, source: 'evaluation' });
          }
        } catch {
          continue;
        }
        const items = Array.isArray(distilled) ? distilled : [distilled].filter(Boolean);
        if (!items.length || !verifier) continue;
        const taskScore =
          report?.score && report.score.passed === report.score.total
            ? report.score
            : { total: 1, passed: 1, failed: 0, cancelled: 0, timedOut: 0 };
        const evidence = {
          projectId: runProjectId,
          sourceTaskId: result.taskId,
          evaluationRunId: run.id,
          score: taskScore,
          ...(report?.score ? { runScore: report.score } : {}),
          evidenceRef: `evaluation:${run.id}:${result.taskId}`,
          deterministic: true,
          passed: true,
          ...(result.judge?.evidence ? { judgeEvidence: result.judge.evidence } : {}),
        };
        for (const item of items) {
          if (!item?.id) continue;
          try {
            verifier({
              projectId: runProjectId,
              id: item.id,
              sourceTaskId: result.taskId,
              evaluationRunId: run.id,
              evidence,
              sourceArtifact: `evaluation:${run.id}:${result.taskId}`,
            });
          } catch {
            // A failed trust grant must not change the evaluation terminal state.
          }
        }
        continue;
      }

      if (result.status === 'failed' || result.status === 'timeout') {
        const telemetryInfo = extractResultTelemetry(result);
        const failureCategory =
          telemetryInfo.failureCategory !== 'none'
            ? telemetryInfo.failureCategory
            : (result.judge?.evidence?.failureCategory ?? result.errorCode ?? result.status ?? 'failed');
        const errorMsg = safeError(
          result.error ||
            result.judge?.reason ||
            (Array.isArray(result.judge?.vetoReasons) && result.judge.vetoReasons.length
              ? result.judge.vetoReasons.join('; ')
              : null) ||
            result.errorCode ||
            result.status,
        );
        try {
          if (typeof this.memory.distillTurnExperience === 'function') {
            this.memory.distillTurnExperience({
              projectId: runProjectId,
              input: taskInput,
              summary: typeof result.output?.output === 'string' ? result.output.output : '',
              workspaceRoot: null,
              verdict: {
                verdict: 'fail',
                accepted: false,
                reasons: [errorMsg],
                checks: result.judge?.evidence?.checks ?? {},
              },
              reasoningMetrics,
              toolReceipts,
              modifiedFiles,
              evaluationEvidence: null,
              error: errorMsg,
              errorCode: result.errorCode ?? result.telemetry?.errorCode ?? null,
              failureCategory,
              source: 'evaluation',
              sourceTaskId: result.taskId,
              sessionId: result.output?.sessionId ?? null,
              turnId: result.output?.turnId ?? null,
              runId: run.id,
            });
          } else {
            this.memory.remember({
              projectId: runProjectId,
              type: 'lesson',
              memoryClass: 'failure_trap_pattern',
              content: `Evaluation task ${result.taskId} failed (${failureCategory}): ${errorMsg}`,
              tags: ['failure_trap_pattern', failureCategory],
              metadata: { failureCategory, error: errorMsg, sourceTaskId: result.taskId, runId: run.id },
              source: 'evaluation',
            }, { projectId: runProjectId, source: 'evaluation' });
          }
        } catch {
          // Failure trap distillation is advisory and cannot alter the evaluation terminal state.
        }
      }
    }
  }

  async close({ timeoutMs = 30_000 } = {}) {
    if (!this.store?.db?.isOpen) return { drained: this.#activeExecutions.size === 0 };
    const activeRuns = this.listRuns({ limit: 200 }).filter((run) => ['queued', 'running'].includes(run.status));
    for (const run of activeRuns) {
      this.#controllers.get(run.id)?.abort('service shutdown');
      this.jobQueue?.cancelByTask?.(run.id);
      if (run.status === 'queued') this.#update(run.id, { status: 'cancelled', finishedAt: Date.now(), cancelRequestedAt: Date.now() });
    }
    const pending = [...this.#activeExecutions.values()];
    if (pending.length) await Promise.race([Promise.allSettled(pending), delay(Math.max(1, Number(timeoutMs) || 30_000))]);
    this.#controllers.clear();
    return { drained: this.#activeExecutions.size === 0 };
  }
}

export { createDirectRuntimeAdapter };





