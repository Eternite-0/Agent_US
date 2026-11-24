import type {
  AciAblationArmMetrics,
  AciAblationSummary,
  AciAdmissionDecisions,
  AciBudgetWatermarks,
  AciTurnTelemetry,
  EventEnvelope,
} from '../types/backend';

const ADMISSION_KEYS: Array<keyof AciAdmissionDecisions> = [
  'DIRECT',
  'SUPPORTING',
  'DEFER',
  'DUPLICATE',
  'IRRELEVANT',
];

function finiteNum(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

export function normalizeAdmissionDecisions(raw: unknown): AciAdmissionDecisions {
  const src = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    DIRECT: Math.max(0, Math.trunc(Number(src.DIRECT ?? 0) || 0)),
    SUPPORTING: Math.max(0, Math.trunc(Number(src.SUPPORTING ?? 0) || 0)),
    DEFER: Math.max(0, Math.trunc(Number(src.DEFER ?? 0) || 0)),
    DUPLICATE: Math.max(0, Math.trunc(Number(src.DUPLICATE ?? 0) || 0)),
    IRRELEVANT: Math.max(0, Math.trunc(Number(src.IRRELEVANT ?? 0) || 0)),
  };
}

export function sumAdmissionDecisions(decisions: AciAdmissionDecisions): number {
  return ADMISSION_KEYS.reduce((sum, key) => sum + (decisions[key] ?? 0), 0);
}

export function extractBudgetWatermarks(payload: Record<string, unknown> | null | undefined): AciBudgetWatermarks | null {
  if (!payload || typeof payload !== 'object') return null;
  const rm = payload.reasoningMetrics && typeof payload.reasoningMetrics === 'object'
    ? (payload.reasoningMetrics as Record<string, unknown>)
    : null;
  const nested =
    (payload.budgetWatermarks && typeof payload.budgetWatermarks === 'object' ? payload.budgetWatermarks : null) ??
    (rm?.budgetWatermarks && typeof rm.budgetWatermarks === 'object' ? rm.budgetWatermarks : null) ??
    (payload.watermarks && typeof payload.watermarks === 'object' ? payload.watermarks : null);
  const src = (nested ?? payload) as Record<string, unknown>;

  const usedTokens = finiteNum(src.usedTokens);
  const maxTokens = finiteNum(src.maxTokens);
  const dtocWatermark = finiteNum(src.dtocWatermark) ?? finiteNum(src.dtocMinPromptTokens);
  const postTestReserveActive =
    typeof src.postTestReserveActive === 'boolean' ? src.postTestReserveActive : undefined;
  const supervisorCircuitOpen =
    typeof src.supervisorCircuitOpen === 'boolean'
      ? src.supervisorCircuitOpen
      : typeof src.circuitOpen === 'boolean'
        ? src.circuitOpen
        : undefined;
  const projectedTotalTokens = finiteNum(src.projectedTotalTokens);

  if (
    !nested &&
    usedTokens === undefined &&
    maxTokens === undefined &&
    dtocWatermark === undefined &&
    postTestReserveActive === undefined &&
    supervisorCircuitOpen === undefined &&
    projectedTotalTokens === undefined
  ) {
    return null;
  }

  return {
    ...(usedTokens !== undefined ? { usedTokens } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(finiteNum(src.utilizationRatio) !== undefined ? { utilizationRatio: finiteNum(src.utilizationRatio) } : {}),
    ...(finiteNum(src.ratio) !== undefined ? { ratio: finiteNum(src.ratio) } : {}),
    ...(finiteNum(src.reserveTokens) !== undefined ? { reserveTokens: finiteNum(src.reserveTokens) } : {}),
    ...(postTestReserveActive !== undefined ? { postTestReserveActive } : {}),
    ...(dtocWatermark !== undefined ? { dtocWatermark } : {}),
    ...(finiteNum(src.dtocMinPromptTokens) !== undefined ? { dtocMinPromptTokens: finiteNum(src.dtocMinPromptTokens) } : {}),
    ...(typeof src.dtocPolicy === 'string' ? { dtocPolicy: src.dtocPolicy } : {}),
    ...(projectedTotalTokens !== undefined ? { projectedTotalTokens } : {}),
    ...(supervisorCircuitOpen !== undefined ? { supervisorCircuitOpen } : {}),
  };
}

export function extractTurnAciTelemetry(
  events: readonly EventEnvelope[] | undefined,
  turnId?: string,
): AciTurnTelemetry | null {
  if (!events?.length) return null;

  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    const p = (ev?.payload ?? {}) as Record<string, unknown>;
    if (turnId && typeof p.turnId === 'string' && p.turnId !== turnId) continue;

    const rm = p.reasoningMetrics && typeof p.reasoningMetrics === 'object'
      ? (p.reasoningMetrics as Record<string, unknown>)
      : null;
    const aci =
      (p.aciTelemetry && typeof p.aciTelemetry === 'object' ? (p.aciTelemetry as Record<string, unknown>) : null) ??
      (rm?.aciTelemetry && typeof rm.aciTelemetry === 'object' ? (rm.aciTelemetry as Record<string, unknown>) : null) ??
      (rm?.aciMetrics && typeof rm.aciMetrics === 'object' ? (rm.aciMetrics as Record<string, unknown>) : null) ??
      (p.aciMetrics && typeof p.aciMetrics === 'object' ? (p.aciMetrics as Record<string, unknown>) : null);
    const budgetWatermarks =
      extractBudgetWatermarks(p) ??
      extractBudgetWatermarks(aci);

    if (!aci && !budgetWatermarks) continue;

    const recoveryStats =
      aci?.recoveryStats && typeof aci.recoveryStats === 'object'
        ? (aci.recoveryStats as Record<string, unknown>)
        : {};
    const dtocStats =
      aci?.dtocStats && typeof aci.dtocStats === 'object'
        ? (aci.dtocStats as Record<string, unknown>)
        : {};
    const supCost =
      aci?.supervisorCost && typeof aci.supervisorCost === 'object'
        ? (aci.supervisorCost as Record<string, unknown>)
        : {};

    const admissionDecisions = normalizeAdmissionDecisions(
      aci?.admissionDecisions ?? aci?.decisions ?? (aci?.ledger as Record<string, unknown> | undefined)?.admissionDecisions,
    );
    const partialRecoveries = Math.max(
      0,
      Math.trunc(Number(aci?.partialRecoveries ?? recoveryStats.partialRecoveries ?? 0) || 0),
    );
    const fullRecoveries = Math.max(
      0,
      Math.trunc(Number(aci?.fullRecoveries ?? recoveryStats.fullRecoveries ?? aci?.restoredCount ?? 0) || 0),
    );
    const recoveryTokensSaved = Math.max(
      0,
      Math.trunc(Number(aci?.recoveryTokensSaved ?? recoveryStats.recoveryTokensSaved ?? 0) || 0),
    );
    const supersededEvictions = Math.max(
      0,
      Math.trunc(Number(aci?.supersededEvictions ?? dtocStats.supersededEvictions ?? aci?.offloadedCount ?? 0) || 0),
    );
    const supersededTokensSaved = Math.max(
      0,
      Math.trunc(Number(aci?.supersededTokensSaved ?? dtocStats.supersededTokensSaved ?? aci?.savedTokens ?? 0) || 0),
    );
    const trajectoryTriggeredEpochs = Math.max(
      0,
      Math.trunc(Number(aci?.trajectoryTriggeredEpochs ?? aci?.epochTransitions ?? 0) || 0),
    );
    const admissionTokensSaved = Math.max(
      0,
      Math.trunc(Number(aci?.admissionTokensSaved ?? aci?.admissionSavedTokens ?? 0) || 0),
    );
    const antiThrashingTriggered = Math.max(
      0,
      Math.trunc(Number(aci?.antiThrashingTriggered ?? rm?.antiThrashingTriggered ?? 0) || 0),
    );
    const supervisorCircuitOpen =
      typeof aci?.supervisorCircuitOpen === 'boolean'
        ? aci.supervisorCircuitOpen
        : typeof budgetWatermarks?.supervisorCircuitOpen === 'boolean'
          ? budgetWatermarks.supervisorCircuitOpen
          : typeof supCost.circuitOpen === 'boolean'
            ? supCost.circuitOpen
            : undefined;

    return {
      ...(typeof p.turnId === 'string' ? { turnId: p.turnId } : {}),
      ...(typeof aci?.aciProfile === 'string' ? { aciProfile: aci.aciProfile } : {}),
      dtocPolicy:
        (typeof aci?.dtocPolicy === 'string' ? aci.dtocPolicy : null) ??
        budgetWatermarks?.dtocPolicy ??
        null,
      admissionDecisions,
      admissionTokensSaved,
      partialRecoveries,
      fullRecoveries,
      recoveryTokensSaved,
      supersededEvictions,
      supersededTokensSaved,
      trajectoryTriggeredEpochs,
      ...(antiThrashingTriggered > 0 ? { antiThrashingTriggered } : {}),
      ...(supervisorCircuitOpen !== undefined ? { supervisorCircuitOpen } : {}),
      ...(finiteNum(aci?.supervisorCalls ?? supCost.calls) !== undefined
        ? { supervisorCalls: finiteNum(aci?.supervisorCalls ?? supCost.calls) }
        : {}),
      budgetWatermarks,
    };
  }

  return null;
}

export function normalizeAciAblationSummary(raw: unknown): AciAblationSummary {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { available: false };
  }
  const obj = raw as Record<string, unknown>;
  if (obj.available === false) {
    return { available: false };
  }

  const metricsObj =
    obj.metrics && typeof obj.metrics === 'object' ? (obj.metrics as Record<string, unknown>) : null;
  const rawByArm =
    (obj.summaryByArm && typeof obj.summaryByArm === 'object' ? obj.summaryByArm : null) ??
    (obj.byArm && typeof obj.byArm === 'object' ? obj.byArm : null) ??
    (metricsObj?.byArm && typeof metricsObj.byArm === 'object' ? metricsObj.byArm : null);

  if (!rawByArm) {
    return { available: false };
  }

  const summaryByArm: Record<string, AciAblationArmMetrics> = {};
  for (const [armKey, val] of Object.entries(rawByArm as Record<string, unknown>)) {
    if (!val || typeof val !== 'object') continue;
    const r = val as Record<string, unknown>;
    const passedTrials = Math.max(0, Math.trunc(Number(r.passedTrials ?? 0) || 0));
    const totalTrials = Math.max(0, Math.trunc(Number(r.totalTrials ?? 0) || 0));
    const rawCi = r.passRateCI && typeof r.passRateCI === 'object' ? (r.passRateCI as Record<string, unknown>) : null;
    const rate = finiteNum(rawCi?.rate) ?? (totalTrials > 0 ? passedTrials / totalTrials : 0);
    const lower = finiteNum(rawCi?.lower) ?? rate;
    const upper = finiteNum(rawCi?.upper) ?? rate;
    const sup = r.supervisorCost && typeof r.supervisorCost === 'object'
      ? (r.supervisorCost as Record<string, unknown>)
      : {};
    const tokBreakdown = r.tokenBreakdown && typeof r.tokenBreakdown === 'object'
      ? (r.tokenBreakdown as Record<string, unknown>)
      : undefined;

    summaryByArm[armKey] = {
      arm: typeof r.arm === 'string' && r.arm ? r.arm : armKey,
      ...(typeof r.aciProfile === 'string' ? { aciProfile: r.aciProfile } : {}),
      totalTrials,
      passedTrials,
      ...(finiteNum(r.failedTrials) !== undefined ? { failedTrials: finiteNum(r.failedTrials) } : {}),
      passRateCI: {
        rate,
        lower,
        upper,
        ...(finiteNum(rawCi?.ci95HalfWidth) !== undefined ? { ci95HalfWidth: finiteNum(rawCi?.ci95HalfWidth) } : {}),
      },
      ...(finiteNum(r.finalTaskSuccessRate) !== undefined ? { finalTaskSuccessRate: finiteNum(r.finalTaskSuccessRate) } : {}),
      pairedPassTokenReduction:
        r.pairedPassTokenReduction === null || r.pairedPassTokenReduction === undefined
          ? null
          : finiteNum(r.pairedPassTokenReduction) ?? null,
      ...(finiteNum(r.pairedPassCount) !== undefined ? { pairedPassCount: finiteNum(r.pairedPassCount) } : {}),
      tokensPerCompletedPass:
        r.tokensPerCompletedPass === null || r.tokensPerCompletedPass === undefined
          ? null
          : finiteNum(r.tokensPerCompletedPass) ?? null,
      ...(r.meanTokensOnPassedTrials !== undefined
        ? { meanTokensOnPassedTrials: finiteNum(r.meanTokensOnPassedTrials) ?? null }
        : {}),
      cacheHitRate: finiteNum(r.cacheHitRate) ?? 0,
      supervisorCost: {
        ...(finiteNum(sup.calls) !== undefined ? { calls: finiteNum(sup.calls) } : {}),
        ...(finiteNum(sup.inputTokens) !== undefined ? { inputTokens: finiteNum(sup.inputTokens) } : {}),
        ...(finiteNum(sup.outputTokens) !== undefined ? { outputTokens: finiteNum(sup.outputTokens) } : {}),
        totalTokens: finiteNum(sup.totalTokens) ?? 0,
        ...(finiteNum(sup.durationMs) !== undefined ? { durationMs: finiteNum(sup.durationMs) } : {}),
        ...(finiteNum(sup.tokenShareOfTotal) !== undefined ? { tokenShareOfTotal: finiteNum(sup.tokenShareOfTotal) } : {}),
      },
      ...(tokBreakdown
        ? {
            tokenBreakdown: {
              ...(finiteNum(tokBreakdown.totalTokens) !== undefined ? { totalTokens: finiteNum(tokBreakdown.totalTokens) } : {}),
              ...(finiteNum(tokBreakdown.meanTokens) !== undefined ? { meanTokens: finiteNum(tokBreakdown.meanTokens) } : {}),
            },
          }
        : {}),
      ...(finiteNum(r.supersededEvictions) !== undefined ? { supersededEvictions: finiteNum(r.supersededEvictions) } : {}),
      ...(finiteNum(r.supersededTokensSaved) !== undefined ? { supersededTokensSaved: finiteNum(r.supersededTokensSaved) } : {}),
      ...(finiteNum(r.partialRecoveries) !== undefined ? { partialRecoveries: finiteNum(r.partialRecoveries) } : {}),
      ...(finiteNum(r.recoveryTokensSaved) !== undefined ? { recoveryTokensSaved: finiteNum(r.recoveryTokensSaved) } : {}),
      ...(finiteNum(r.antiThrashingTriggered) !== undefined ? { antiThrashingTriggered: finiteNum(r.antiThrashingTriggered) } : {}),
      ...(r.decisions && typeof r.decisions === 'object' ? { decisions: normalizeAdmissionDecisions(r.decisions) } : {}),
    };
  }

  const keys = Object.keys(summaryByArm);
  if (!keys.length) return { available: false };

  const defaultOrder = ['A', 'B', 'C', 'D'].filter((k) => keys.includes(k));
  const armOrderRaw = Array.isArray(obj.armOrder)
    ? obj.armOrder.map(String).filter((k) => keys.includes(k))
    : Array.isArray(metricsObj?.arms)
      ? (metricsObj.arms as unknown[]).map(String).filter((k) => keys.includes(k))
      : [];
  const armOrder = armOrderRaw.length ? armOrderRaw : [...defaultOrder, ...keys.filter((k) => !defaultOrder.includes(k))];

  return {
    available: true,
    ...(typeof obj.suite === 'string' ? { suite: obj.suite } : {}),
    ...(typeof obj.model === 'string' ? { model: obj.model } : {}),
    ...(obj.createdAt !== undefined ? { createdAt: obj.createdAt as number | string } : {}),
    armOrder,
    summaryByArm,
    ...(typeof obj.latexTable === 'string' && obj.latexTable.trim() ? { latexTable: obj.latexTable } : {}),
    ...(typeof obj.markdownTable === 'string' && obj.markdownTable.trim() ? { markdownTable: obj.markdownTable } : {}),
    ...(typeof obj.sourceFile === 'string' ? { sourceFile: obj.sourceFile } : {}),
  };
}

export function formatAciAblationLatexFallback(summary: AciAblationSummary): string {
  if (!summary.available || !summary.summaryByArm) return '';
  const arms = summary.armOrder ?? Object.keys(summary.summaryByArm);
  const esc = (txt: string) =>
    String(txt)
      .replaceAll('\\', '\\textbackslash{}')
      .replaceAll('&', '\\&')
      .replaceAll('%', '\\%')
      .replaceAll('$', '\\$')
      .replaceAll('#', '\\#')
      .replaceAll('_', '\\_')
      .replaceAll('{', '\\{')
      .replaceAll('}', '\\}');
  const pct = (v: number | null | undefined) =>
    v === null || v === undefined || !Number.isFinite(v) ? '--' : `${(v * 100).toFixed(1)}\\%`;
  const intFmt = (v: number | null | undefined) =>
    v === null || v === undefined || !Number.isFinite(v) ? '--' : Math.round(v).toLocaleString('en-US');

  const lines = [
    '% Agent_US ACI A/C/D Ablation Table',
    '\\begin{table}[htbp]',
    '\\centering',
    `\\caption{ACI Ablation Comparison (${esc(summary.suite ?? 'aci26')}${summary.model ? `, ${esc(summary.model)}` : ''})}`,
    '\\label{tab:aci-ablation-comparison}',
    '\\begin{tabular}{llrrrrrr}',
    '\\toprule',
    'Arm & Profile & Pass & Pass Rate (Wilson 95\\% CI) & Paired-Pass Red & Tok/Pass & Cache Hit & Sup Tok \\\\',
    '\\midrule',
  ];

  for (const arm of arms) {
    const m = summary.summaryByArm[arm];
    if (!m) continue;
    const ci = `${(m.passRateCI.rate * 100).toFixed(1)}\\% [${(m.passRateCI.lower * 100).toFixed(1)}\\%, ${(m.passRateCI.upper * 100).toFixed(1)}\\%]`;
    const paired =
      m.pairedPassTokenReduction === null
        ? '--'
        : `${(m.pairedPassTokenReduction * 100).toFixed(1)}\\% (n=${m.pairedPassCount ?? 0})`;
    lines.push(
      `${esc(arm)} & \\texttt{${esc(m.aciProfile ?? arm)}} & ${m.passedTrials}/${m.totalTrials} & ${ci} & ${paired} & ${intFmt(m.tokensPerCompletedPass)} & ${pct(m.cacheHitRate)} & ${intFmt(m.supervisorCost?.totalTokens)} \\\\`,
    );
  }

  lines.push('\\bottomrule', '\\end{tabular}', '\\end{table}');
  return lines.join('\n') + '\n';
}
