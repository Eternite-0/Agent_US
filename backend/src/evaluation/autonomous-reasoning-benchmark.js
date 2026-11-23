import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  EVIDENCE_MANIFEST_SCHEMA_VERSION,
  EVIDENCE_STATUSES,
  formatEvidenceManifestContract,
  normalizeEvidencePath,
  validateEvidenceManifest,
} from './schemas.js';
import {
  createFixtureWorkspace,
  getWorkspaceBaselineCommit,
  listWorkspaceChangedFiles,
  verifyWorkspacePinnedBaseline,
} from './fixtures.js';
import {
  BenchmarkSandbox,
  SANDBOX_MODES,
  isPathInsideRoot,
  runHardenedGit,
  runHardenedGitSync,
} from '../tools/benchmark-sandbox.js';
import { computeSha256Hex, computeWorkspaceArtifactDigest } from './hidden-acceptance.js';
import { DEFAULT_DEPENDENCY_POLICY, validatePackageDependencies } from './dependency-policy.js';
import { enforceDeterministicHardVeto } from './judge.js';
import { estimateTaskBudget } from '../planning/budget-estimator.js';
import { parseReviewerOutput, REVIEWER_SCHEMA_VERSION } from '../swarm/reviewer.js';

export const AUTONOMOUS_REASONING_BENCHMARK_ID = 'agent-us-autonomous-reasoning-2.4';
export const VERSION = '1.0.0';

export const FAILURE_ATTRIBUTIONS = Object.freeze({
  NONE: 'none',
  TOOL_MECHANISM: 'tool_mechanism',
  MODEL_CAPABILITY: 'model_capability',
  RUNTIME_RELIABILITY: 'runtime_reliability',
});

export const AUTONOMOUS_REASONING_TASK_IDS = Object.freeze([
  'ar-01-unfamiliar-codebase',
  'ar-02-complex-bug-root-cause',
  'ar-03-multi-file-feature',
  'ar-04-cross-module-refactor',
  'ar-05-security-vuln-fix',
  'ar-06-test-failure-repair',
  'ar-07-multi-stage-dev',
  'ar-08-mid-task-recovery',
  'ar-09-multi-agent-collab',
  'ar-10-long-horizon-delivery',
]);

const DEFAULT_SANDBOX_BY_MODE = new Map();

function getDefaultBenchmarkSandbox() {
  const modeKey = `${process.env.AGENT_US_BENCHMARK_SANDBOX_MODE || SANDBOX_MODES.STRONG}:${process.env.AGENT_US_BENCHMARK_ALLOW_PROCESS_HARDENING_ONLY === '1' ? '1' : '0'}`;
  let sbx = DEFAULT_SANDBOX_BY_MODE.get(modeKey);
  if (!sbx) {
    sbx = new BenchmarkSandbox();
    DEFAULT_SANDBOX_BY_MODE.set(modeKey, sbx);
  }
  return sbx;
}

function sha256Text(text) {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex');
}

function round4(value) {
  return Number((Number(value) || 0).toFixed(4));
}

function readWorkspaceText(workspaceRoot, relPath) {
  try {
    const abs = join(workspaceRoot, relPath);
    if (!isPathInsideRoot(workspaceRoot, abs, { allowEqual: false })) return null;
    return readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
}

function readWorkspaceJson(workspaceRoot, relPath) {
  const text = readWorkspaceText(workspaceRoot, relPath);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function computeFileHashes(filesMap, relPaths = []) {
  const hashes = {};
  for (const rel of relPaths) {
    const norm = normalizeEvidencePath(rel);
    if (Object.hasOwn(filesMap, norm)) {
      hashes[norm] = sha256Text(filesMap[norm]);
    }
  }
  return Object.freeze(hashes);
}

async function checkFilesUnmodifiedSince(workspaceRoot, baselineCommit, protectedFiles = [], expectedHashes = {}) {
  const modified = new Set();
  if (!protectedFiles.length && !Object.keys(expectedHashes).length) {
    return { ok: true, modified: [] };
  }
  const targets = [...new Set([...protectedFiles, ...Object.keys(expectedHashes)].map(normalizeEvidencePath).filter(Boolean))];
  if (baselineCommit && /^[0-9a-f]{40,64}$/i.test(baselineCommit)) {
    try {
      const res = await runHardenedGit(
        ['diff', '--no-ext-diff', '--name-only', baselineCommit, '--', ...targets],
        { cwd: workspaceRoot, allowNetwork: false },
      );
      if (res.error || res.exitCode !== 0) {
        return { ok: false, modified: targets };
      }
      for (const line of res.stdout.split(/\r?\n/)) {
        const norm = normalizeEvidencePath(line);
        if (norm) modified.add(norm);
      }
    } catch {
      return { ok: false, modified: targets };
    }
  }
  for (const [rel, expectedSha] of Object.entries(expectedHashes)) {
    const diskText = readWorkspaceText(workspaceRoot, rel);
    if (diskText === null || sha256Text(diskText) !== expectedSha) {
      modified.add(rel);
    }
  }
  return { ok: modified.size === 0, modified: [...modified].sort() };
}

async function hasRealSourceDiff(workspaceRoot, baselineCommit, requiredFiles = [], changedFiles = null) {
  if (!requiredFiles.length) return true;
  const changed = new Set((changedFiles ?? listWorkspaceChangedFiles(workspaceRoot)).map(normalizeEvidencePath));
  const normalized = requiredFiles.map(normalizeEvidencePath);
  for (const rel of normalized) {
    if (!changed.has(rel)) return false;
    const abs = join(workspaceRoot, rel);
    if (!existsSync(abs) || !isPathInsideRoot(workspaceRoot, abs, { allowEqual: false })) return false;
  }
  try {
    const lsRes = await runHardenedGit(['ls-files', '-z', '--', ...normalized], {
      cwd: workspaceRoot,
      allowNetwork: false,
    });
    if (lsRes.error || lsRes.exitCode !== 0) return false;
    const trackedSet = new Set(lsRes.stdout.split('\0').map(normalizeEvidencePath).filter(Boolean));
    const trackedFiles = [];
    for (const rel of normalized) {
      if (trackedSet.has(rel)) {
        trackedFiles.push(rel);
      } else {
        const text = readWorkspaceText(workspaceRoot, rel);
        if (text === null || text.trim().length === 0) return false;
      }
    }
    if (trackedFiles.length > 0 && baselineCommit) {
      const diffRes = await runHardenedGit(
        ['diff', '--no-ext-diff', '--name-only', '-z', baselineCommit, '--', ...trackedFiles],
        { cwd: workspaceRoot, allowNetwork: false },
      );
      if (diffRes.error || diffRes.exitCode !== 0) return false;
      const diffSet = new Set(diffRes.stdout.split('\0').map(normalizeEvidencePath).filter(Boolean));
      for (const rel of trackedFiles) {
        if (!diffSet.has(rel)) return false;
      }
    }
  } catch {
    return false;
  }
  return true;
}

function classifyFailureCategory({
  historyUntouched,
  baselineTestsUntampered,
  protectedFilesUntampered,
  depCheckOk,
  hiddenResult,
  implementationPassed,
  testsPassed,
  validation,
  extraChecks,
}) {
  if (
    historyUntouched &&
    baselineTestsUntampered &&
    protectedFilesUntampered &&
    depCheckOk &&
    implementationPassed &&
    testsPassed &&
    validation.valid
  ) {
    return 'none';
  }
  if (!historyUntouched) return 'history_tampered';
  if (!baselineTestsUntampered) return 'baseline_tests_tampered';
  if (!protectedFilesUntampered) return 'protected_files_tampered';
  if (!depCheckOk) return 'dependency_policy_violation';
  if (hiddenResult?.tamperingDetected) return 'hidden_acceptance_tampered';
  if (extraChecks && extraChecks.surfaceSymptomPatch) {
    return 'surface_symptom_patch';
  }
  if (extraChecks && extraChecks.constraintsPreserved === false) {
    return 'constraint_dropped';
  }
  if (!hiddenResult?.passed || !hiddenResult?.verified) return 'hidden_acceptance_failed';
  if (!implementationPassed || !validation.checks.changedFiles) return 'implementation_failed';
  if (!testsPassed || !validation.checks.testReceiptVerified) return 'test_failed';
  if (validation.status === EVIDENCE_STATUSES.INCOMPLETE) return 'evidence_incomplete';
  if (!validation.checks.independentVerdict) return 'independent_verdict_failed';
  return 'evidence_invalid';
}

export function classifyAutonomousReasoningAttribution(trial = {}) {
  const passed = trial?.passed === true && trial?.hardVetoed !== true;
  if (passed && trial?.status !== 'timeout' && trial?.status !== 'cancelled' && trial?.status !== 'failed') {
    return FAILURE_ATTRIBUTIONS.NONE;
  }

  if (trial?.failureAttribution && Object.values(FAILURE_ATTRIBUTIONS).includes(trial.failureAttribution)) {
    if (trial.failureAttribution !== FAILURE_ATTRIBUTIONS.NONE || passed) {
      return trial.failureAttribution;
    }
  }

  const ev = trial?.judge?.evidence ?? trial?.evidence ?? {};
  const errorCode = String(
    trial?.errorCode ?? trial?.telemetry?.errorCode ?? ev?.errorCode ?? '',
  ).toUpperCase();
  const failureCategory = String(trial?.failureCategory ?? ev?.failureCategory ?? '').toLowerCase();
  const failureKind = String(trial?.failureKind ?? trial?.telemetry?.failureKind ?? '').toLowerCase();
  const reason = String(trial?.error ?? trial?.judge?.reason ?? ev?.reason ?? '').toLowerCase();
  const status = String(trial?.status ?? '').toLowerCase();

  // 1. Tool mechanism failures: policy/approval rejections, schema errors, sandbox violations, selection errors, missing tool receipts
  if (
    /POLICY_DENIED|APPROVAL_DENIED|APPROVAL_ARGS_MISMATCH|TOOL_SCHEMA|INVALID_TOOL_ARGS|MCP_TOOL_ERROR|E_SANDBOX_/.test(errorCode) ||
    failureKind === 'tool_failure' ||
    ['tool_selection_error', 'tool_schema_invalid', 'tool_call_as_text', 'dependency_policy_violation'].includes(failureCategory) ||
    ev?.checks?.testReceiptVerified === false ||
    Number(trial?.invalidToolCalls ?? 0) > 0
  ) {
    return FAILURE_ATTRIBUTIONS.TOOL_MECHANISM;
  }

  // 2. Runtime reliability failures: timeouts, crashes, lease loss, reconciliation blocks, budget exhaustion, stale/unresolved verification gate, compaction/recovery failure
  if (
    status === 'timeout' ||
    status === 'cancelled' ||
    Boolean(trial?.infraError) ||
    /STEP_BUDGET|TOKEN_BUDGET|TASK_DEADLINE|LOOP_THRASHING_ABORT|TURN_DRAIN_TIMEOUT|LEASE_LOST|RECONCILIATION_REQUIRED|STALE_VERIFICATION_AFTER_EDIT|UNRESOLVED_VERIFICATION_FAILURE|FABRICATED_PASS_CLAIM|VERIFICATION_MISSING|E_EVAL_TIMEOUT|E_SANDBOX_UNAVAILABLE/.test(errorCode) ||
    /timeout|cancelled|reconcil|lease_lost|step_budget|token_budget|thrashing|stale_verification|unresolved_verification|runtime_error|infra|checkpoint_corrupted/.test(failureCategory) ||
    /timeout|cancelled|reconcil|lease_lost|step_budget|thrashing|stale_verification|unresolved_verification|sandbox_unavailable/.test(reason) ||
    failureCategory === 'evidence_incomplete' ||
    failureCategory === 'independent_verdict_failed'
  ) {
    return FAILURE_ATTRIBUTIONS.RUNTIME_RELIABILITY;
  }

  // 3. Model capability failures: root-cause missed, surface patch, incomplete/incorrect fix, baseline test tampering, constraint drop
  return FAILURE_ATTRIBUTIONS.MODEL_CAPABILITY;
}

function makeAutonomousReasoningJudge({
  requiredSourceFiles,
  hiddenAcceptanceScript,
  protectedReadOnlyFiles = [],
  rootCauseFiles = null,
  extraCheck = null,
}) {
  return async function autonomousReasoningJudge({ task, output, context = {} }) {
    const workspaceRoot = context.workspaceRoot;
    const acceptance = task.metadata.acceptanceCriteria;
    const baselineTestFiles = task.fixture?.baselineTestFiles ?? [];
    const baselineTestCommand = task.fixture?.baselineTestCommand ?? ['node', '--test', ...baselineTestFiles];
    const baselineFileHashes = task.fixture?.baselineFileHashes ?? {};

    const activeSandbox = context.sandbox ?? getDefaultBenchmarkSandbox();
    const resolvedBackend = activeSandbox.resolveBackend();
    const sandboxBackend = resolvedBackend?.mode ?? activeSandbox.mode ?? null;
    const isolationTier = resolvedBackend?.isolationTier ?? null;
    const strongOsIsolation = Boolean(resolvedBackend?.strongOsIsolation);
    const dockerProbe = sandboxBackend === SANDBOX_MODES.DOCKER ? activeSandbox.dockerSandbox?.probe?.() : null;

    const isolationMeta = task.metadata?.sandboxIsolation ?? {};
    const allowWorkspaceNodeCli = Boolean(isolationMeta.allowWorkspaceNodeCli);
    const memoryLimitMb = isolationMeta.memoryLimitMb ?? 512;
    const cpuLimitSec = isolationMeta.cpuLimitSec ?? 20;
    const timeoutMs = isolationMeta.timeoutMs ?? 30_000;
    const dependencyPolicy = task.metadata?.dependencyPolicy ?? DEFAULT_DEPENDENCY_POLICY;

    let depCheck = { ok: true, violations: [], dependencyCount: 0, hasLifecycleScripts: false };
    const pkgPath = join(workspaceRoot, 'package.json');
    if (existsSync(pkgPath)) {
      if (!isPathInsideRoot(workspaceRoot, pkgPath, { allowEqual: false })) {
        depCheck = {
          ok: false,
          violations: [{ type: 'symlink_escape', message: 'package.json escapes workspaceRoot' }],
          dependencyCount: 0,
          hasLifecycleScripts: false,
        };
      } else {
        try {
          const pkgJson = JSON.parse(readFileSync(pkgPath, 'utf8'));
          depCheck = validatePackageDependencies(pkgJson, dependencyPolicy);
        } catch (err) {
          depCheck = {
            ok: false,
            violations: [{ type: 'invalid_package_json', message: String(err?.message ?? err) }],
            dependencyCount: 0,
            hasLifecycleScripts: false,
          };
        }
      }
    }

    const attemptId =
      context.attemptId ??
      output?.attemptId ??
      (context.attempt != null ? `attempt-${context.attempt}` : 'attempt-1');
    const sessionNonce = context.sessionNonce ?? randomUUID();

    const pinnedCommit = task.fixture?.commit || getWorkspaceBaselineCommit(workspaceRoot);
    const historyCheck = pinnedCommit
      ? verifyWorkspacePinnedBaseline(workspaceRoot, pinnedCommit)
      : {
          ok: false,
          expectedCommit: null,
          recordedCommit: null,
          headCommit: null,
          reason: 'missing_baseline_commit',
        };

    const actualFiles = listWorkspaceChangedFiles(workspaceRoot);
    const artifactDigest = computeWorkspaceArtifactDigest(workspaceRoot);

    const protectedHashes = {};
    for (const rel of [...baselineTestFiles, ...protectedReadOnlyFiles]) {
      const norm = normalizeEvidencePath(rel);
      if (baselineFileHashes[norm]) protectedHashes[norm] = baselineFileHashes[norm];
    }

    const [baselineFileCheck, protectedCheck, sourceDiffPresent] = await Promise.all([
      checkFilesUnmodifiedSince(
        workspaceRoot,
        pinnedCommit,
        baselineTestFiles,
        Object.fromEntries(
          baselineTestFiles
            .map(normalizeEvidencePath)
            .filter((f) => baselineFileHashes[f])
            .map((f) => [f, baselineFileHashes[f]]),
        ),
      ),
      checkFilesUnmodifiedSince(
        workspaceRoot,
        pinnedCommit,
        protectedReadOnlyFiles,
        protectedHashes,
      ),
      historyCheck.ok
        ? hasRealSourceDiff(workspaceRoot, pinnedCommit, requiredSourceFiles, actualFiles)
        : Promise.resolve(false),
    ]);

    const historyUntouched = Boolean(historyCheck.ok);
    const baselineTestsUntampered = Boolean(baselineFileCheck.ok);
    const protectedFilesUntampered = Boolean(protectedCheck.ok);

    let baselineTestExitCode = 1;
    let actualTestExitCode = 1;
    let hiddenResult = {
      passed: false,
      verified: false,
      exitCode: 1,
      tamperingDetected: !historyUntouched || !baselineTestsUntampered,
      reason: 'skipped_due_to_integrity_or_policy_failure',
      expectedCount: 0,
      executedCount: 0,
      passedCount: 0,
      failedCount: 0,
      skippedCount: 0,
      todoCount: 0,
      tests: [],
      envelopeDigest: null,
      artifactDigest,
      error: 'skipped_due_to_integrity_or_policy_failure',
    };

    if (historyUntouched && baselineTestsUntampered && protectedFilesUntampered && depCheck.ok) {
      const [baselineRun, actualRun, hiddenRun] = await Promise.all([
        activeSandbox.execArgv(baselineTestCommand, {
          workspaceRoot,
          cwd: workspaceRoot,
          allowWorkspaceNodeCli,
          dependencyPolicy,
          memoryLimitMb,
          cpuLimitSec,
          timeoutMs,
        }),
        activeSandbox.execArgv(acceptance.testCommand, {
          workspaceRoot,
          cwd: workspaceRoot,
          allowWorkspaceNodeCli,
          dependencyPolicy,
          memoryLimitMb,
          cpuLimitSec,
          timeoutMs,
        }),
        activeSandbox.runHiddenAcceptance({
          workspaceRoot,
          scriptSource: hiddenAcceptanceScript,
          taskId: task.id,
          attemptId: String(attemptId),
          sessionNonce: String(sessionNonce),
          artifactDigest,
          allowWorkspaceNodeCli,
          memoryLimitMb,
          cpuLimitSec,
          timeoutMs,
          extraEnv: { AGENT_US_EVAL_WORKSPACE: workspaceRoot },
        }),
      ]);

      baselineTestExitCode = baselineRun.timedOut ? 124 : baselineRun.exitCode;
      actualTestExitCode = actualRun.timedOut ? 124 : actualRun.exitCode;

      const hiddenAllExecuted =
        hiddenRun.verified === true &&
        !hiddenRun.tamperingDetected &&
        !hiddenRun.timedOut &&
        Number.isInteger(hiddenRun.expectedCount) &&
        hiddenRun.expectedCount > 0 &&
        hiddenRun.executedCount === hiddenRun.expectedCount &&
        hiddenRun.passedCount === hiddenRun.expectedCount &&
        (hiddenRun.failedCount ?? 0) === 0 &&
        (hiddenRun.skippedCount ?? 0) === 0 &&
        (hiddenRun.todoCount ?? 0) === 0;
      const hiddenPassedStrict = Boolean(hiddenRun.passed && hiddenAllExecuted);

      hiddenResult = {
        passed: hiddenPassedStrict,
        verified: Boolean(hiddenRun.verified),
        exitCode: hiddenRun.exitCode,
        tamperingDetected: Boolean(hiddenRun.tamperingDetected),
        reason: hiddenRun.reason ?? (hiddenPassedStrict ? 'none' : 'hidden_acceptance_failed'),
        expectedCount: hiddenRun.expectedCount ?? 0,
        executedCount: hiddenRun.executedCount ?? 0,
        passedCount: hiddenRun.passedCount ?? 0,
        failedCount: hiddenRun.failedCount ?? 0,
        skippedCount: hiddenRun.skippedCount ?? 0,
        todoCount: hiddenRun.todoCount ?? 0,
        tests: Array.isArray(hiddenRun.tests) ? hiddenRun.tests : [],
        envelopeDigest: hiddenRun.envelopeDigest ?? null,
        artifactDigest: hiddenRun.artifactDigest ?? artifactDigest,
        error: hiddenPassedStrict
          ? null
          : String(
              hiddenRun.error ||
                hiddenRun.reason ||
                hiddenRun.stderr ||
                hiddenRun.stdout ||
                'hidden acceptance test failed',
            ).slice(0, 1000),
      };
    }

    const extraChecks = extraCheck
      ? extraCheck({ workspaceRoot, actualFiles, hiddenResult })
      : {};
    const changedSet = new Set(actualFiles.map(normalizeEvidencePath));
    const rootCauseFilesTouched = Array.isArray(rootCauseFiles) && rootCauseFiles.length > 0
      ? rootCauseFiles.every((f) => changedSet.has(normalizeEvidencePath(f)))
      : sourceDiffPresent;
    const rootCauseMatch = Boolean(
      extraChecks.rootCauseMatch !== undefined
        ? extraChecks.rootCauseMatch && hiddenResult.passed
        : rootCauseFilesTouched && hiddenResult.passed,
    );
    const extraPassed = Object.values(extraChecks).every(Boolean);

    const validation = validateEvidenceManifest(output, {
      taskId: task.id,
      attemptId,
      planVersion: context.planVersion ?? output?.planVersion ?? 1,
      expectedTestCommand: acceptance.testCommand,
      requiredChangedFiles: acceptance.requiredChangedFiles,
      actualChangedFiles: actualFiles,
      actualTestExitCode,
      toolReceipts: context.toolReceipts ?? output?.toolReceipts ?? null,
      workspaceRoot,
      artifactVerifier: context.artifactVerifier ?? output?.artifactVerifier ?? null,
      trustedVerdict: context.trustedVerdict ?? output?.trustedVerdict ?? null,
      requireIndependentVerdict: true,
    });

    const evidence = validation.manifest ?? {};
    const checks = {
      ...validation.checks,
      historyUntouched,
      baselineTestsUntampered,
      protectedFilesUntampered,
      sourceDiffPresent,
      rootCauseMatch,
      baselineTestsPassed: baselineTestExitCode === 0,
      hiddenAcceptancePassed: hiddenResult.passed,
      hiddenAcceptanceVerified: hiddenResult.verified,
      hiddenAcceptanceTamperingDetected: hiddenResult.tamperingDetected,
      sandboxIsolated: true,
      strongOsIsolation,
      dependencyPolicyPassed: depCheck.ok,
      ...extraChecks,
    };

    const implementationPassed =
      historyUntouched &&
      baselineTestsUntampered &&
      protectedFilesUntampered &&
      depCheck.ok &&
      sourceDiffPresent &&
      hiddenResult.passed &&
      extraPassed &&
      Boolean(checks.changedFiles);
    const regressionPassed =
      baselineTestsUntampered &&
      baselineTestExitCode === 0 &&
      actualTestExitCode === 0;
    const testsPassed =
      regressionPassed &&
      hiddenResult.passed &&
      hiddenResult.verified &&
      !hiddenResult.tamperingDetected &&
      Boolean(checks.testReceiptVerified);
    const evidenceCompliant = Boolean(validation.valid);
    const passed = implementationPassed && testsPassed && evidenceCompliant;

    const failureCategory = classifyFailureCategory({
      historyUntouched,
      baselineTestsUntampered,
      protectedFilesUntampered,
      depCheckOk: depCheck.ok,
      hiddenResult,
      implementationPassed,
      testsPassed,
      validation,
      extraChecks: {
        ...extraChecks,
        rootCauseMatch,
        surfaceSymptomPatch:
          Array.isArray(rootCauseFiles) &&
          rootCauseFiles.length > 0 &&
          actualFiles.length > 0 &&
          !rootCauseFilesTouched &&
          !hiddenResult.passed,
      },
    });

    const errorMessages = [
      ...validation.errors,
      ...(hiddenResult.error ? [hiddenResult.error] : []),
      ...(protectedCheck.modified.length
        ? [`Protected read-only files were modified: ${protectedCheck.modified.join(', ')}`]
        : []),
      ...depCheck.violations.map((v) => v.message),
    ];

    const preliminary = {
      passed,
      score: passed ? 1 : 0,
      deterministic: true,
      reason: passed
        ? 'autonomous_reasoning_acceptance_complete'
        : validation.status === EVIDENCE_STATUSES.INCOMPLETE && implementationPassed && testsPassed
          ? EVIDENCE_STATUSES.INCOMPLETE
          : failureCategory,
      evidence: {
        taskId: task.id,
        category: task.category,
        area: task.area,
        schemaVersion: EVIDENCE_MANIFEST_SCHEMA_VERSION,
        repoUrl: task.fixture?.repoUrl ?? null,
        pinnedCommit,
        baselineCommitObserved: historyCheck.headCommit,
        historyUntouched,
        historyReason: historyCheck.reason,
        baselineTestsUntampered,
        protectedFilesUntampered,
        tamperedBaselineTestFiles: baselineFileCheck.modified,
        tamperedProtectedFiles: protectedCheck.modified,
        attemptId: evidence.attemptId ?? attemptId ?? null,
        planVersion: evidence.planVersion ?? context.planVersion ?? 1,
        manifestStatus: validation.status,
        missingFields: validation.missingFields,
        errors: errorMessages,
        actualChangedFiles: actualFiles,
        reportedChangedFiles: Array.isArray(evidence.changedFiles)
          ? evidence.changedFiles.map(normalizeEvidencePath)
          : [],
        actualTestExitCode,
        baselineTestExitCode,
        hiddenAcceptanceExitCode: hiddenResult.exitCode,
        hiddenAcceptancePassed: hiddenResult.passed,
        hiddenAcceptanceVerified: hiddenResult.verified,
        hiddenAcceptanceTamperingDetected: hiddenResult.tamperingDetected,
        hiddenAcceptanceReason: hiddenResult.reason,
        hiddenAcceptanceExpectedCount: hiddenResult.expectedCount,
        hiddenAcceptanceExecutedCount: hiddenResult.executedCount,
        hiddenAcceptancePassedCount: hiddenResult.passedCount,
        hiddenAcceptanceTests: hiddenResult.tests,
        hiddenAcceptanceEnvelopeDigest: hiddenResult.envelopeDigest,
        artifactDigest: hiddenResult.artifactDigest,
        reportedTestExitCode: Number.isInteger(evidence.testExitCode) ? evidence.testExitCode : null,
        expectedTestCommand: acceptance.testCommand,
        reportedTestCommand: evidence.testCommand ?? null,
        implementationPassed,
        testsPassed,
        regressionPassed,
        rootCauseMatch,
        evidenceCompliant,
        sandboxIsolated: true,
        sandboxBackend,
        isolationTier,
        strongOsIsolation,
        dockerImage: dockerProbe?.image ?? null,
        dockerImageDigest: dockerProbe?.imageDigest ?? null,
        dependencyPolicyPassed: depCheck.ok,
        ...(depCheck.violations.length ? { dependencyPolicyViolations: depCheck.violations } : {}),
        independentVerdictSource: validation.independentVerdictSource,
        failureCategory,
        failureAttribution: FAILURE_ATTRIBUTIONS.NONE,
        checks,
      },
    };

    const vetoed = enforceDeterministicHardVeto(preliminary, context.advisory ?? null);
    const attribution = classifyAutonomousReasoningAttribution({
      ...context.trialMeta,
      passed: vetoed.passed,
      hardVetoed: vetoed.hardVetoed,
      status: vetoed.passed ? 'passed' : 'failed',
      failureCategory,
      judge: vetoed,
      evidence: vetoed.evidence,
    });
    vetoed.evidence.failureAttribution = attribution;
    return vetoed;
  };
}

function buildMetadata({
  id,
  area,
  requiredChangedFiles,
  testFiles,
  testCommand,
  repoFileCount,
  allowWorkspaceNodeCli = false,
  recoveryRequirements = false,
  rootCauseFiles = null,
}) {
  return {
    source: AUTONOMOUS_REASONING_BENCHMARK_ID,
    benchmarkVersion: VERSION,
    adapter: 'direct-agent-runtime',
    synthetic: true,
    externalNetwork: false,
    requiresWorkspaceMutation: true,
    requiresGitDiff: true,
    requiresIndependentVerification: true,
    area,
    ...(rootCauseFiles ? { rootCauseFiles } : {}),
    sandboxIsolation: {
      required: true,
      failClosed: true,
      allowWorkspaceNodeCli,
      memoryLimitMb: 512,
      cpuLimitSec: 20,
      timeoutMs: 30_000,
    },
    dependencyPolicy: { ...DEFAULT_DEPENDENCY_POLICY },
    repoFileCount,
    recoveryRequirements,
    acceptance: [
      'pinned_commit_history_untouched',
      'baseline_tests_untampered',
      'workspace_changed',
      'baseline_tests_pass',
      'hidden_acceptance_tests_pass',
      'git_diff_captured',
      'independent_verdict',
    ],
    verificationStrategy: 'frozen-git-repo-and-docker-hidden-acceptance',
    expectedArtifacts: requiredChangedFiles,
    acceptanceCriteria: {
      requiredFiles: requiredChangedFiles,
      requiredChangedFiles,
      testFiles,
      testCommand,
      checks: ['pinned_history_untouched', 'baseline_tests_pass', 'hidden_acceptance_pass'],
    },
  };
}

// ---------------------------------------------------------------------------
// 10 Frozen-Git-Repo Autonomous Reasoning Tasks
// ---------------------------------------------------------------------------

const RAW_TASKS = [
  // 1) ar-01-unfamiliar-codebase
  {
    id: 'ar-01-unfamiliar-codebase',
    area: 'unfamiliar_codebase_understanding',
    title: 'Multi-File Codebase Understanding & Contract Extraction',
    objective: 'Trace actual module imports and precedence rules instead of stale documentation, producing a verifiable CONTRACT.json and ANALYSIS.md.',
    prompt: [
      'Inspect the codebase without relying on README.md (which may be stale).',
      'Trace imports starting from src/index.js through src/config/*, src/pipeline/*, and src/server/router.js.',
      'Produce:',
      '1. CONTRACT.json with keys: entryPoint, port, rateLimit, authHeader, precedence, routes (array of { path, handler, middlewares }), and sources (sorted array of source paths).',
      '2. ANALYSIS.md citing every traversed source path (src/index.js, src/config/defaults.js, src/config/env-loader.js, src/pipeline/registry.js, src/pipeline/stages/auth.js, src/pipeline/stages/rate-limit.js, src/server/router.js) and explaining config precedence and middleware wiring.',
      'Do NOT modify any files under src/ or test/baseline.test.js. Run `node --test test/baseline.test.js`.',
    ].join('\n'),
    fixture: {
      files: {
        'package.json': JSON.stringify({ name: 'ar-01-gateway', version: '1.0.0', type: 'module' }, null, 2),
        'README.md': [
          '# Gateway Service (Legacy Notes)',
          'Old v1 deployment listened on port 3000 with route /api/v1/orders, rateLimit 100, and header X-Api-Key.',
          'Check src/index.js for the live runtime contract.',
        ].join('\n'),
        'src/config/defaults.js': 'export const DEFAULTS = Object.freeze({ port: 4000, rateLimit: 60, authHeader: "x-legacy-key" });\n',
        'src/config/env-loader.js': [
          "import { DEFAULTS } from './defaults.js';",
          'export const PROFILE_OVERRIDES = Object.freeze({ prod: { port: 8420, rateLimit: 25, authHeader: "x-tenant-token" } });',
          'export function loadConfig(env = {}) {',
          '  const profile = PROFILE_OVERRIDES[env.APP_PROFILE || "prod"] || {};',
          '  const merged = { ...DEFAULTS, ...profile };',
          '  if (env.PORT !== undefined) merged.port = Number(env.PORT);',
          '  if (env.RATE_LIMIT !== undefined) merged.rateLimit = Number(env.RATE_LIMIT);',
          '  return Object.freeze(merged);',
          '}',
        ].join('\n'),
        'src/pipeline/stages/auth.js': 'export function createAuthStage(cfg) { return { name: "auth", header: cfg.authHeader }; }\n',
        'src/pipeline/stages/rate-limit.js': 'export function createRateLimitStage(cfg) { return { name: "rate-limit", limit: cfg.rateLimit }; }\n',
        'src/pipeline/registry.js': [
          "import { createAuthStage } from './stages/auth.js';",
          "import { createRateLimitStage } from './stages/rate-limit.js';",
          'export function buildStages(cfg) { return [createAuthStage(cfg), createRateLimitStage(cfg)]; }',
        ].join('\n'),
        'src/server/router.js': [
          "import { buildStages } from '../pipeline/registry.js';",
          'export function buildRoutes(cfg) {',
          '  const stages = buildStages(cfg).map((s) => s.name);',
          '  return [',
          '    { path: "/v2/orders", handler: "ordersHandler", middlewares: stages },',
          '    { path: "/healthz", handler: "healthHandler", middlewares: [] },',
          '  ];',
          '}',
        ].join('\n'),
        'src/index.js': [
          "import { loadConfig } from './config/env-loader.js';",
          "import { buildRoutes } from './server/router.js';",
          'export function boot(env = {}) {',
          '  const config = loadConfig(env);',
          '  return { config, routes: buildRoutes(config) };',
          '}',
        ].join('\n'),
        'test/baseline.test.js': [
          "import test from 'node:test';",
          "import assert from 'node:assert/strict';",
          "import { boot } from '../src/index.js';",
          "test('gateway boots deterministically', () => {",
          '  const app = boot();',
          '  assert.equal(app.config.port, 8420);',
          '  assert.equal(app.routes.length, 2);',
          '});',
        ].join('\n'),
      },
      baselineTestFiles: ['test/baseline.test.js'],
      baselineTestCommand: ['node', '--test', 'test/baseline.test.js'],
    },
    judge: makeAutonomousReasoningJudge({
      requiredSourceFiles: ['CONTRACT.json', 'ANALYSIS.md'],
      protectedReadOnlyFiles: [
        'src/index.js',
        'src/config/defaults.js',
        'src/config/env-loader.js',
        'src/pipeline/registry.js',
        'src/pipeline/stages/auth.js',
        'src/pipeline/stages/rate-limit.js',
        'src/server/router.js',
      ],
      extraCheck: ({ workspaceRoot, actualFiles }) => {
        const touchedSrc = actualFiles.some((f) => f.startsWith('src/'));
        const contract = readWorkspaceJson(workspaceRoot, 'CONTRACT.json');
        const analysis = readWorkspaceText(workspaceRoot, 'ANALYSIS.md') ?? '';
        const paths = [
          'src/index.js',
          'src/config/defaults.js',
          'src/config/env-loader.js',
          'src/pipeline/registry.js',
          'src/pipeline/stages/auth.js',
          'src/pipeline/stages/rate-limit.js',
          'src/server/router.js',
        ];
        return {
          noSrcMutation: !touchedSrc,
          contractValid: Boolean(
            contract &&
              contract.port === 8420 &&
              contract.rateLimit === 25 &&
              contract.authHeader === 'x-tenant-token' &&
              Array.isArray(contract.routes) &&
              contract.routes.some((r) => r.path === '/v2/orders'),
          ),
          analysisCitations: paths.every((p) => analysis.includes(p)),
        };
      },
      hiddenAcceptanceScript: `
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ws = process.env.WORKSPACE_ROOT || process.env.AGENT_US_EVAL_WORKSPACE;

test('hidden acceptance: CONTRACT.json matches real module graph', () => {
  const contract = JSON.parse(readFileSync(join(ws, 'CONTRACT.json'), 'utf8'));
  assert.equal(contract.entryPoint, 'src/index.js');
  assert.equal(contract.port, 8420);
  assert.equal(contract.rateLimit, 25);
  assert.equal(contract.authHeader, 'x-tenant-token');
  assert.deepEqual(contract.precedence, ['env', 'profile', 'defaults']);
  assert.deepEqual(contract.routes, [
    { path: '/v2/orders', handler: 'ordersHandler', middlewares: ['auth', 'rate-limit'] },
    { path: '/healthz', handler: 'healthHandler', middlewares: [] },
  ]);
  assert.deepEqual([...contract.sources].sort(), [
    'src/config/defaults.js',
    'src/config/env-loader.js',
    'src/index.js',
    'src/pipeline/registry.js',
    'src/pipeline/stages/auth.js',
    'src/pipeline/stages/rate-limit.js',
    'src/server/router.js',
  ]);
});

test('hidden acceptance: ANALYSIS.md cites all real source dependencies', () => {
  const analysis = readFileSync(join(ws, 'ANALYSIS.md'), 'utf8');
  for (const p of [
    'src/index.js',
    'src/config/defaults.js',
    'src/config/env-loader.js',
    'src/pipeline/registry.js',
    'src/pipeline/stages/auth.js',
    'src/pipeline/stages/rate-limit.js',
    'src/server/router.js',
  ]) {
    assert.ok(analysis.includes(p), 'missing citation: ' + p);
  }
  assert.match(analysis, /precedence|env/i);
  assert.match(analysis, /auth/i);
});
`,
    }),
    metadata: buildMetadata({
      id: 'ar-01-unfamiliar-codebase',
      area: 'unfamiliar_codebase_understanding',
      requiredChangedFiles: ['CONTRACT.json', 'ANALYSIS.md'],
      testFiles: ['test/baseline.test.js'],
      testCommand: ['node', '--test', 'test/baseline.test.js'],
      repoFileCount: 10,
    }),
  },

  // 2) ar-02-complex-bug-root-cause
  {
    id: 'ar-02-complex-bug-root-cause',
    area: 'complex_bug_root_cause',
    title: 'Multi-File Call-Chain Root Cause Localization & Fix',
    objective: 'Fix bugs across currency, discount, and tax modules rather than applying a surface-level patch in checkout.',
    prompt: [
      'A multi-module pricing pipeline exhibits rounding drift, lost remainder cents, and tax overcharging on discounted orders.',
      'Trace the full call chain across src/pricing/checkout.js -> src/pricing/discount.js -> src/pricing/tax.js -> src/pricing/currency.js.',
      'Fix the root causes in the underlying modules (NOT a superficial hardcode in checkout.js):',
      '1. src/pricing/currency.js: toMinorUnits(dollars) must round half-up accurately avoiding IEEE-754 drift (e.g. 19.99 -> 1999, 1.005 -> 101); allocateProportional(totalCents, weights) must preserve exact sum via largest-remainder allocation.',
      '2. src/pricing/discount.js: clamp percent to [0, 100], apply discount on aggregate subtotal (Math.round(subtotal * (1 - pct / 100))), and compute proportional line discountedCents using allocateProportional.',
      '3. src/pricing/tax.js: compute tax on post-discount taxable amounts (`line.discountedCents`), NOT pre-discount prices, excluding taxExempt lines.',
      '4. Add regression tests in test/root-cause.test.js without modifying test/checkout.test.js, and run `node --test test/checkout.test.js test/root-cause.test.js`.',
    ].join('\n'),
    fixture: {
      files: {
        'package.json': JSON.stringify({ name: 'ar-02-pricing', version: '1.0.0', type: 'module' }, null, 2),
        'src/pricing/currency.js': [
          'export function toMinorUnits(dollars) {',
          '  return Math.trunc(Number(dollars) * 100);',
          '}',
          'export function allocateProportional(totalCents, weights) {',
          '  const sum = weights.reduce((a, b) => a + b, 0);',
          '  if (sum <= 0) return weights.map(() => 0);',
          '  return weights.map((w) => Math.floor((totalCents * w) / sum));',
          '}',
        ].join('\n'),
        'src/pricing/discount.js': [
          "import { allocateProportional } from './currency.js';",
          'export function applyDiscount(items, coupon) {',
          '  const pct = Number(coupon?.percent ?? 0);',
          '  const lines = items.map((item) => {',
          '    const gross = item.priceCents * item.qty;',
          '    const net = Math.round(gross * (1 - pct / 100));',
          '    return { ...item, grossCents: gross, discountedCents: net };',
          '  });',
          '  const subtotalCents = lines.reduce((s, l) => s + l.grossCents, 0);',
          '  const discountedSubtotalCents = lines.reduce((s, l) => s + l.discountedCents, 0);',
          '  return { lines, subtotalCents, discountedSubtotalCents, allocateProportional };',
          '}',
        ].join('\n'),
        'src/pricing/tax.js': [
          'const RATES = Object.freeze({ US: 0.08, EU: 0.2 });',
          'export function computeTax(lines, region = "US") {',
          '  const rate = RATES[region] ?? 0;',
          '  const taxableCents = lines.reduce((sum, line) => sum + line.grossCents, 0);',
          '  return Math.round(taxableCents * rate);',
          '}',
        ].join('\n'),
        'src/pricing/checkout.js': [
          "import { applyDiscount } from './discount.js';",
          "import { computeTax } from './tax.js';",
          'export function checkout({ items, coupon = null, region = "US" }) {',
          '  const discounted = applyDiscount(items, coupon);',
          '  const taxCents = computeTax(discounted.lines, region);',
          '  return {',
          '    subtotalCents: discounted.subtotalCents,',
          '    discountedSubtotalCents: discounted.discountedSubtotalCents,',
          '    taxCents,',
          '    totalCents: discounted.discountedSubtotalCents + taxCents,',
          '    lines: discounted.lines,',
          '  };',
          '}',
        ].join('\n'),
        'test/checkout.test.js': [
          "import test from 'node:test';",
          "import assert from 'node:assert/strict';",
          "import { checkout } from '../src/pricing/checkout.js';",
          "test('baseline zero-discount US checkout', () => {",
          '  const res = checkout({ items: [{ priceCents: 1000, qty: 2 }], region: "US" });',
          '  assert.equal(res.subtotalCents, 2000);',
          '  assert.equal(res.taxCents, 160);',
          '  assert.equal(res.totalCents, 2160);',
          '});',
        ].join('\n'),
      },
      baselineTestFiles: ['test/checkout.test.js'],
      baselineTestCommand: ['node', '--test', 'test/checkout.test.js'],
    },
    judge: makeAutonomousReasoningJudge({
      requiredSourceFiles: ['src/pricing/currency.js', 'src/pricing/discount.js', 'src/pricing/tax.js', 'test/root-cause.test.js'],
      rootCauseFiles: ['src/pricing/currency.js', 'src/pricing/discount.js', 'src/pricing/tax.js'],
      hiddenAcceptanceScript: `
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ws = process.env.WORKSPACE_ROOT || process.env.AGENT_US_EVAL_WORKSPACE;

test('hidden acceptance: currency.js handles float precision and largest-remainder allocation', async () => {
  const { toMinorUnits, allocateProportional } = await import(pathToFileURL(join(ws, 'src/pricing/currency.js')).href);
  assert.equal(toMinorUnits(19.99), 1999);
  assert.equal(toMinorUnits(1.005), 101);
  const alloc = allocateProportional(100, [1, 1, 1]);
  assert.equal(alloc.reduce((a, b) => a + b, 0), 100);
  assert.deepEqual(alloc, [34, 33, 33]);
});

test('hidden acceptance: discount.js clamps percent and avoids per-line rounding drift', async () => {
  const { applyDiscount } = await import(pathToFileURL(join(ws, 'src/pricing/discount.js')).href);
  const res = applyDiscount(
    [{ priceCents: 333, qty: 1 }, { priceCents: 333, qty: 1 }, { priceCents: 333, qty: 1 }],
    { percent: 15 },
  );
  assert.equal(res.subtotalCents, 999);
  assert.equal(res.discountedSubtotalCents, 849);
  assert.equal(res.lines.reduce((s, l) => s + l.discountedCents, 0), 849);
  const clampedHigh = applyDiscount([{ priceCents: 500, qty: 1 }], { percent: 150 });
  assert.equal(clampedHigh.discountedSubtotalCents, 0);
  const clampedLow = applyDiscount([{ priceCents: 500, qty: 1 }], { percent: -20 });
  assert.equal(clampedLow.discountedSubtotalCents, 500);
});

test('hidden acceptance: tax.js computes tax on post-discount non-exempt lines and checkout matches', async () => {
  const { computeTax } = await import(pathToFileURL(join(ws, 'src/pricing/tax.js')).href);
  const { checkout } = await import(pathToFileURL(join(ws, 'src/pricing/checkout.js')).href);
  assert.equal(computeTax([{ grossCents: 2000, discountedCents: 1000, taxExempt: false }], 'EU'), 200);
  assert.equal(computeTax([{ grossCents: 2000, discountedCents: 1000, taxExempt: true }], 'EU'), 0);
  const order = checkout({
    items: [
      { priceCents: 1000, qty: 1, taxExempt: false },
      { priceCents: 500, qty: 1, taxExempt: true },
    ],
    coupon: { percent: 20 },
    region: 'EU',
  });
  assert.equal(order.discountedSubtotalCents, 1200);
  assert.equal(order.taxCents, 160);
  assert.equal(order.totalCents, 1360);
});
`,
    }),
    metadata: buildMetadata({
      id: 'ar-02-complex-bug-root-cause',
      area: 'complex_bug_root_cause',
      requiredChangedFiles: ['src/pricing/currency.js', 'src/pricing/discount.js', 'src/pricing/tax.js', 'test/root-cause.test.js'],
      testFiles: ['test/checkout.test.js', 'test/root-cause.test.js'],
      testCommand: ['node', '--test', 'test/checkout.test.js', 'test/root-cause.test.js'],
      repoFileCount: 6,
      rootCauseFiles: ['src/pricing/currency.js', 'src/pricing/discount.js', 'src/pricing/tax.js'],
    }),
  },

  // 3) ar-03-multi-file-feature
  {
    id: 'ar-03-multi-file-feature',
    area: 'multi_file_feature',
    title: 'Coordinated Multi-File Feature, Exports & Public Tests',
    objective: 'Implement deterministic cursor-based pagination and filtering across multiple modules and package exports.',
    prompt: [
      'Implement cursor-based paginated query support across:',
      '1. src/query/filter.js: add matchesWhere(record, where) supporting exact equality and { gte, lte, in } operators.',
      '2. src/query/paginate.js: implement encodeCursor(payload), decodeCursor(cursor) (throwing TypeError on invalid/malformed cursor), and paginateRecords(records, { sortBy, order, cursor, limit }). Deterministic tie-break on `id` ascending.',
      '3. src/store/memory-store.js & src/index.js: add store.query(options) / queryRecords(store, options) and export all public helpers.',
      '4. Add tests in test/query-pagination.test.js without modifying test/store.test.js. Run `node --test test/store.test.js test/query-pagination.test.js`.',
    ].join('\n'),
    fixture: {
      files: {
        'package.json': JSON.stringify({
          name: 'ar-03-query-store',
          version: '1.0.0',
          type: 'module',
          exports: { '.': './src/index.js', './store': './src/store/memory-store.js' },
        }, null, 2),
        'src/query/filter.js': 'export function matchesWhere(record, where = {}) { return Boolean(record && where); }\n',
        'src/query/paginate.js': 'export function paginateRecords(records) { return { items: records, nextCursor: null }; }\n',
        'src/store/memory-store.js': [
          'export class MemoryStore {',
          '  constructor(initial = []) { this.records = [...initial]; }',
          '  insert(rec) { this.records.push(rec); return rec; }',
          '  all() { return [...this.records]; }',
          '}',
        ].join('\n'),
        'src/index.js': [
          "export { MemoryStore } from './store/memory-store.js';",
          "export { matchesWhere } from './query/filter.js';",
          "export { paginateRecords } from './query/paginate.js';",
        ].join('\n'),
        'test/store.test.js': [
          "import test from 'node:test';",
          "import assert from 'node:assert/strict';",
          "import { MemoryStore } from '../src/index.js';",
          "test('memory store insert and all', () => {",
          '  const s = new MemoryStore([{ id: "a", score: 1 }]);',
          '  assert.equal(s.all().length, 1);',
          '});',
        ].join('\n'),
      },
      baselineTestFiles: ['test/store.test.js'],
      baselineTestCommand: ['node', '--test', 'test/store.test.js'],
    },
    judge: makeAutonomousReasoningJudge({
      requiredSourceFiles: ['src/query/filter.js', 'src/query/paginate.js', 'src/store/memory-store.js', 'src/index.js', 'test/query-pagination.test.js'],
      hiddenAcceptanceScript: `
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ws = process.env.WORKSPACE_ROOT || process.env.AGENT_US_EVAL_WORKSPACE;

test('hidden acceptance: coordinated filter, stable cursor pagination, and exports', async () => {
  const pkg = await import(pathToFileURL(join(ws, 'src/index.js')).href);
  assert.equal(typeof pkg.encodeCursor, 'function');
  assert.equal(typeof pkg.decodeCursor, 'function');
  assert.equal(typeof pkg.queryRecords, 'function');
  assert.throws(() => pkg.decodeCursor('not-valid-base64!!!'), TypeError);

  const store = new pkg.MemoryStore([
    { id: 'r2', tenant: 'acme', score: 10 },
    { id: 'r1', tenant: 'acme', score: 10 },
    { id: 'r3', tenant: 'beta', score: 30 },
    { id: 'r4', tenant: 'acme', score: 20 },
  ]);

  const page1 = pkg.queryRecords(store, {
    where: { tenant: 'acme', score: { gte: 10 } },
    sortBy: 'score',
    order: 'desc',
    limit: 2,
  });
  assert.deepEqual(page1.items.map((x) => x.id), ['r4', 'r1']);
  assert.ok(typeof page1.nextCursor === 'string' && page1.nextCursor.length > 0);

  const page2 = store.query({
    where: { tenant: 'acme', score: { gte: 10 } },
    sortBy: 'score',
    order: 'desc',
    cursor: page1.nextCursor,
    limit: 2,
  });
  assert.deepEqual(page2.items.map((x) => x.id), ['r2']);
  assert.equal(page2.nextCursor, null);
});
`,
    }),
    metadata: buildMetadata({
      id: 'ar-03-multi-file-feature',
      area: 'multi_file_feature',
      requiredChangedFiles: ['src/query/filter.js', 'src/query/paginate.js', 'src/store/memory-store.js', 'src/index.js', 'test/query-pagination.test.js'],
      testFiles: ['test/store.test.js', 'test/query-pagination.test.js'],
      testCommand: ['node', '--test', 'test/store.test.js', 'test/query-pagination.test.js'],
      repoFileCount: 6,
    }),
  },

  // 4) ar-04-cross-module-refactor
  {
    id: 'ar-04-cross-module-refactor',
    area: 'cross_module_refactor',
    title: 'Behavior-Preserving Extraction Across 3 Modules',
    objective: 'Extract duplicated record normalization across csv-reader, tsv-writer, and report-formatter into a single shared module.',
    prompt: [
      'src/ingest/csv-reader.js, src/export/tsv-writer.js, and src/audit/report-formatter.js all duplicate record canonicalization and whitespace/control sanitization.',
      '1. Create src/shared/record-normalizer.js exporting sanitizeField(value), canonicalizeRecord(raw, columns), and stableColumns(records).',
      '2. Refactor all 3 modules to import and use ../shared/record-normalizer.js, removing duplicated inline helper logic while preserving exact public exports and behavior.',
      '3. Add test/normalizer.test.js without modifying test/pipeline.test.js. Run `node --test test/pipeline.test.js test/normalizer.test.js`.',
    ].join('\n'),
    fixture: {
      files: {
        'package.json': JSON.stringify({ name: 'ar-04-refactor', version: '1.0.0', type: 'module' }, null, 2),
        'src/ingest/csv-reader.js': [
          'function cleanVal(v) { return String(v ?? "").replace(/[\\r\\n\\t]+/g, " ").trim(); }',
          'export function parseCsvRow(headers, values) {',
          '  const rec = {};',
          '  for (let i = 0; i < headers.length; i++) rec[cleanVal(headers[i]).toLowerCase()] = cleanVal(values[i]);',
          '  return rec;',
          '}',
        ].join('\n'),
        'src/export/tsv-writer.js': [
          'function cleanVal(v) { return String(v ?? "").replace(/[\\r\\n\\t]+/g, " ").trim(); }',
          'export function formatTsvRow(record, columns) {',
          '  const cols = [...columns].sort();',
          '  return cols.map((c) => cleanVal(record[c.toLowerCase()] ?? record[c])).join("\\t");',
          '}',
        ].join('\n'),
        'src/audit/report-formatter.js': [
          'function cleanVal(v) { return String(v ?? "").replace(/[\\r\\n\\t]+/g, " ").trim(); }',
          'export function formatAuditEntry(record) {',
          '  const keys = Object.keys(record).map((k) => cleanVal(k).toLowerCase()).sort();',
          '  return keys.map((k) => `${k}=${cleanVal(record[k] ?? record[k.toUpperCase()])}`).join("; ");',
          '}',
        ].join('\n'),
        'test/pipeline.test.js': [
          "import test from 'node:test';",
          "import assert from 'node:assert/strict';",
          "import { parseCsvRow } from '../src/ingest/csv-reader.js';",
          "import { formatTsvRow } from '../src/export/tsv-writer.js';",
          "import { formatAuditEntry } from '../src/audit/report-formatter.js';",
          "test('pipeline preserves legacy behavior', () => {",
          "  const rec = parseCsvRow([' User ', 'Role'], [' Ada\\n', 'Admin\\t']);",
          "  assert.deepEqual(rec, { user: 'Ada', role: 'Admin' });",
          "  assert.equal(formatTsvRow(rec, ['user', 'role']), 'Admin\\tAda');",
          "  assert.equal(formatAuditEntry(rec), 'role=Admin; user=Ada');",
          '});',
        ].join('\n'),
      },
      baselineTestFiles: ['test/pipeline.test.js'],
      baselineTestCommand: ['node', '--test', 'test/pipeline.test.js'],
    },
    judge: makeAutonomousReasoningJudge({
      requiredSourceFiles: [
        'src/shared/record-normalizer.js',
        'src/ingest/csv-reader.js',
        'src/export/tsv-writer.js',
        'src/audit/report-formatter.js',
        'test/normalizer.test.js',
      ],
      hiddenAcceptanceScript: `
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ws = process.env.WORKSPACE_ROOT || process.env.AGENT_US_EVAL_WORKSPACE;

test('hidden acceptance: all 3 modules delegate to shared record-normalizer without duplicating cleanVal', async () => {
  const norm = await import(pathToFileURL(join(ws, 'src/shared/record-normalizer.js')).href);
  const csv = await import(pathToFileURL(join(ws, 'src/ingest/csv-reader.js')).href);
  const tsv = await import(pathToFileURL(join(ws, 'src/export/tsv-writer.js')).href);
  const audit = await import(pathToFileURL(join(ws, 'src/audit/report-formatter.js')).href);

  assert.equal(norm.sanitizeField(' a\\r\\n\\tb '), 'a b');
  assert.deepEqual(norm.stableColumns([{ b: 1, a: 2 }, { c: 3, a: 4 }]), ['a', 'b', 'c']);
  const rec = norm.canonicalizeRecord({ ' Name ': ' Grace\\t' }, ['name', 'dept']);
  assert.deepEqual(rec, { name: 'Grace', dept: '' });

  assert.deepEqual(csv.parseCsvRow([' ID ', 'Note'], ['1', 'x\\ny']), { id: '1', note: 'x y' });
  assert.equal(tsv.formatTsvRow({ z: '9', a: '1\\t2' }, ['z', 'a']), '1 2\\t9');
  assert.equal(audit.formatAuditEntry({ b: '2', a: '1\\n' }), 'a=1; b=2');

  for (const rel of ['src/ingest/csv-reader.js', 'src/export/tsv-writer.js', 'src/audit/report-formatter.js']) {
    const src = readFileSync(join(ws, rel), 'utf8');
    assert.match(src, /\\.\\.\\/shared\\/record-normalizer\\.js/, rel + ' must import shared normalizer');
    assert.ok(!src.includes('function cleanVal'), rel + ' must remove duplicated cleanVal helper');
  }
});
`,
    }),
    metadata: buildMetadata({
      id: 'ar-04-cross-module-refactor',
      area: 'cross_module_refactor',
      requiredChangedFiles: [
        'src/shared/record-normalizer.js',
        'src/ingest/csv-reader.js',
        'src/export/tsv-writer.js',
        'src/audit/report-formatter.js',
        'test/normalizer.test.js',
      ],
      testFiles: ['test/pipeline.test.js', 'test/normalizer.test.js'],
      testCommand: ['node', '--test', 'test/pipeline.test.js', 'test/normalizer.test.js'],
      repoFileCount: 6,
    }),
  },

  // 5) ar-05-security-vuln-fix
  {
    id: 'ar-05-security-vuln-fix',
    area: 'security_vulnerability_fix',
    title: 'Path Traversal & Prototype Pollution Hardening',
    objective: 'Fix directory/symlink traversal and prototype-pollution vulnerabilities verified by an exploit test suite.',
    prompt: [
      'Audit and harden the two security boundaries:',
      '1. src/fs/safe-bundle.js: resolveBundlePath(rootDir, entryPath) must reject null bytes, absolute/drive paths, URL-encoded traversal (%2e%2e), backslashes/parent segments, sibling-prefix escapes (/tmp/ws vs /tmp/ws-evil), and symlinks whose canonical target escapes rootDir.',
      '2. src/config/deep-merge.js: mergeConfig(target, source) must perform safe deep merge while blocking __proto__, constructor, and prototype pollution across nested objects and JSON.parse payloads.',
      '3. Document findings & fixes in SECURITY.md and add tests in test/security-regression.test.js without editing test/security-baseline.test.js. Run `node --test test/security-baseline.test.js test/security-regression.test.js`.',
    ].join('\n'),
    fixture: {
      files: {
        'package.json': JSON.stringify({ name: 'ar-05-security', version: '1.0.0', type: 'module' }, null, 2),
        'src/fs/safe-bundle.js': [
          "import { join } from 'node:path';",
          'export function resolveBundlePath(rootDir, entryPath) {',
          '  return join(rootDir, entryPath);',
          '}',
        ].join('\n'),
        'src/config/deep-merge.js': [
          'export function mergeConfig(target, source) {',
          '  const out = { ...target };',
          '  for (const key of Object.keys(source || {})) {',
          '    if (source[key] && typeof source[key] === "object" && !Array.isArray(source[key])) {',
          '      out[key] = mergeConfig(out[key] || {}, source[key]);',
          '    } else {',
          '      out[key] = source[key];',
          '    }',
          '  }',
          '  return out;',
          '}',
        ].join('\n'),
        'src/index.js': [
          "export { resolveBundlePath } from './fs/safe-bundle.js';",
          "export { mergeConfig } from './config/deep-merge.js';",
        ].join('\n'),
        'test/security-baseline.test.js': [
          "import test from 'node:test';",
          "import assert from 'node:assert/strict';",
          "import { mergeConfig } from '../src/index.js';",
          "test('baseline safe merge preserves normal nested options', () => {",
          '  assert.deepEqual(mergeConfig({ a: { x: 1 } }, { a: { y: 2 } }), { a: { x: 1, y: 2 } });',
          '});',
        ].join('\n'),
      },
      baselineTestFiles: ['test/security-baseline.test.js'],
      baselineTestCommand: ['node', '--test', 'test/security-baseline.test.js'],
    },
    judge: makeAutonomousReasoningJudge({
      requiredSourceFiles: ['src/fs/safe-bundle.js', 'src/config/deep-merge.js', 'SECURITY.md', 'test/security-regression.test.js'],
      rootCauseFiles: ['src/fs/safe-bundle.js', 'src/config/deep-merge.js'],
      hiddenAcceptanceScript: `
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ws = process.env.WORKSPACE_ROOT || process.env.AGENT_US_EVAL_WORKSPACE;

test('hidden acceptance: resolveBundlePath blocks traversal, prefix collision, and symlink escapes', async () => {
  const base = mkdtempSync(join(tmpdir(), 'ar05-sec-'));
  const root = join(base, 'ws');
  const evil = join(base, 'ws-evil');
  mkdirSync(join(root, 'sub'), { recursive: true });
  mkdirSync(evil, { recursive: true });
  writeFileSync(join(evil, 'secret.txt'), 'secret');
  writeFileSync(join(root, 'sub', 'ok.txt'), 'ok');
  let symlinkCreated = false;
  try {
    symlinkSync(evil, join(root, 'escape-link'), process.platform === 'win32' ? 'junction' : 'dir');
    symlinkCreated = true;
  } catch (err) {
    // Node --permission (fallback mode when Docker is absent) forbids fs.symlink without full fs.write=*.
    if (!(err?.code === 'ERR_ACCESS_DENIED' && process.permission && !process.permission.has('fs.write', '*'))) {
      throw err;
    }
  }
  const { resolveBundlePath } = await import(pathToFileURL(join(ws, 'src/fs/safe-bundle.js')).href);

  try {
    assert.ok(resolveBundlePath(root, 'sub/ok.txt').endsWith('ok.txt'));
    const badInputs = [
      '../ws-evil/secret.txt',
      '..\\\\ws-evil\\\\secret.txt',
      '/etc/passwd',
      'C:\\\\Windows\\\\System32',
      'sub/%2e%2e/%2e%2e/ws-evil/secret.txt',
      'sub/ok.txt\\0.png',
      ...(symlinkCreated ? ['escape-link/secret.txt'] : []),
    ];
    for (const bad of badInputs) {
      assert.throws(() => resolveBundlePath(root, bad), Error, 'expected rejection for ' + bad);
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('hidden acceptance: mergeConfig blocks __proto__ and constructor.prototype pollution', async () => {
  const { mergeConfig } = await import(pathToFileURL(join(ws, 'src/config/deep-merge.js')).href);
  const protoPayload = JSON.parse('{"__proto__":{"pollutedA":true},"nested":{"safe":1}}');
  const mergedA = mergeConfig({}, protoPayload);
  assert.equal(({}).pollutedA, undefined);
  assert.equal(mergedA.nested.safe, 1);

  const ctorPayload = { constructor: { prototype: { pollutedB: true } }, prototype: { pollutedC: true } };
  mergeConfig({}, ctorPayload);
  assert.equal(({}).pollutedB, undefined);
  assert.equal(({}).pollutedC, undefined);

  const secDoc = readFileSync(join(ws, 'SECURITY.md'), 'utf8');
  assert.match(secDoc, /traversal|symlink/i);
  assert.match(secDoc, /__proto__|prototype/i);
});
`,
    }),
    metadata: buildMetadata({
      id: 'ar-05-security-vuln-fix',
      area: 'security_vulnerability_fix',
      requiredChangedFiles: ['src/fs/safe-bundle.js', 'src/config/deep-merge.js', 'SECURITY.md', 'test/security-regression.test.js'],
      testFiles: ['test/security-baseline.test.js', 'test/security-regression.test.js'],
      testCommand: ['node', '--test', 'test/security-baseline.test.js', 'test/security-regression.test.js'],
      repoFileCount: 6,
      rootCauseFiles: ['src/fs/safe-bundle.js', 'src/config/deep-merge.js'],
    }),
  },

  // 6) ar-06-test-failure-repair
  {
    id: 'ar-06-test-failure-repair',
    area: 'test_failure_repair',
    title: 'Regression Repair Rejecting Weakened Baseline Tests',
    objective: 'Fix failing backoff and sliding-window implementations so the untouched baseline test suite and hidden edge tests pass.',
    prompt: [
      'Run `node --test test/backoff.test.js` first to observe the failing assertions.',
      'Repair the production implementations ONLY (do NOT edit or weaken test/backoff.test.js):',
      '1. src/scheduler/backoff.js: computeBackoffMs(attempt, { baseMs, maxMs, jitterRatio }) must clamp negative/NaN attempts safely to 0, avoid exponent overflow, enforce maxMs cap, and apply bounded symmetric jitter within [0, maxMs].',
      '2. src/scheduler/window.js: SlidingWindowLimiter.allow(timestampMs) must prune entries <= timestampMs - windowMs (exact boundary is expired) and enforce limit cleanly without off-by-one drift.',
      'Run `node --test test/backoff.test.js`.',
    ].join('\n'),
    fixture: {
      files: {
        'package.json': JSON.stringify({ name: 'ar-06-scheduler', version: '1.0.0', type: 'module' }, null, 2),
        'src/scheduler/backoff.js': [
          'export function computeBackoffMs(attempt, { baseMs = 200, maxMs = 10000, jitterRatio = 0 } = {}) {',
          '  return baseMs * (2 ** attempt);',
          '}',
        ].join('\n'),
        'src/scheduler/window.js': [
          'export class SlidingWindowLimiter {',
          '  constructor({ limit = 3, windowMs = 1000 } = {}) { this.limit = limit; this.windowMs = windowMs; this.hits = []; }',
          '  allow(nowMs) {',
          '    this.hits = this.hits.filter((t) => nowMs - t <= this.windowMs);',
          '    if (this.hits.length > this.limit) return false;',
          '    this.hits.push(nowMs);',
          '    return true;',
          '  }',
          '}',
        ].join('\n'),
        'test/backoff.test.js': [
          "import test from 'node:test';",
          "import assert from 'node:assert/strict';",
          "import { computeBackoffMs } from '../src/scheduler/backoff.js';",
          "import { SlidingWindowLimiter } from '../src/scheduler/window.js';",
          "test('backoff clamps negative attempts and enforces cap', () => {",
          '  assert.equal(computeBackoffMs(-3, { baseMs: 200, maxMs: 5000 }), 200);',
          '  assert.equal(computeBackoffMs(20, { baseMs: 200, maxMs: 5000 }), 5000);',
          '});',
          "test('sliding window rejects exact limit overflow and expires boundary', () => {",
          '  const lim = new SlidingWindowLimiter({ limit: 2, windowMs: 100 });',
          '  assert.equal(lim.allow(10), true);',
          '  assert.equal(lim.allow(20), true);',
          '  assert.equal(lim.allow(30), false);',
          '  assert.equal(lim.allow(110), true);',
          '});',
        ].join('\n'),
      },
      baselineTestFiles: ['test/backoff.test.js'],
      baselineTestCommand: ['node', '--test', 'test/backoff.test.js'],
    },
    judge: makeAutonomousReasoningJudge({
      requiredSourceFiles: ['src/scheduler/backoff.js', 'src/scheduler/window.js'],
      rootCauseFiles: ['src/scheduler/backoff.js', 'src/scheduler/window.js'],
      hiddenAcceptanceScript: `
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ws = process.env.WORKSPACE_ROOT || process.env.AGENT_US_EVAL_WORKSPACE;

test('hidden acceptance: backoff handles NaN, Infinity, huge attempts, and jitter bounds', async () => {
  const { computeBackoffMs } = await import(pathToFileURL(join(ws, 'src/scheduler/backoff.js')).href);
  assert.equal(computeBackoffMs(Number.NaN, { baseMs: 100, maxMs: 1000 }), 100);
  assert.equal(computeBackoffMs(10000, { baseMs: 100, maxMs: 1000 }), 1000);
  for (let i = 0; i < 20; i++) {
    const val = computeBackoffMs(1, { baseMs: 200, maxMs: 300, jitterRatio: 0.5 });
    assert.ok(val >= 0 && val <= 300, 'jittered delay out of bounds: ' + val);
  }
});

test('hidden acceptance: sliding window prunes <= now - windowMs strictly', async () => {
  const { SlidingWindowLimiter } = await import(pathToFileURL(join(ws, 'src/scheduler/window.js')).href);
  const lim = new SlidingWindowLimiter({ limit: 1, windowMs: 50 });
  assert.equal(lim.allow(100), true);
  assert.equal(lim.allow(149), false);
  assert.equal(lim.allow(150), true);
});
`,
    }),
    metadata: buildMetadata({
      id: 'ar-06-test-failure-repair',
      area: 'test_failure_repair',
      requiredChangedFiles: ['src/scheduler/backoff.js', 'src/scheduler/window.js'],
      testFiles: ['test/backoff.test.js'],
      testCommand: ['node', '--test', 'test/backoff.test.js'],
      repoFileCount: 4,
      rootCauseFiles: ['src/scheduler/backoff.js', 'src/scheduler/window.js'],
    }),
  },

  // 7) ar-07-multi-stage-dev
  {
    id: 'ar-07-multi-stage-dev',
    area: 'multi_stage_development',
    title: 'Multi-Stage Delivery: Spec -> Parser -> Validator -> CLI -> Tests',
    objective: 'Build a complete policy manifest pipeline from SPEC.md through parser, validator, CLI, and integration tests.',
    prompt: [
      'Implement the full multi-stage feature described in SPEC.md:',
      '1. src/parser.js: parseManifest(text) ignoring blank/# comment lines, parsing `KEY = VALUE` (unquoting "..." / \'...\'), tracking line numbers, and rejecting malformed syntax or duplicate keys with structured errors.',
      '2. src/validator.js: validateManifest(parsed, { strict }) checking required keys (`SERVICE_NAME`, `PORT`, `MODE`), PORT integer 1..65535, MODE in (`dev`, `staging`, `prod`), and rejecting unknown keys when strict=true.',
      '3. bin/policy-cli.js: accept `--file <path>`, `--format json|text`, `--strict`; exit 0 when valid, 2 on validation/parse errors, 1 on missing/invalid CLI usage.',
      '4. Add end-to-end tests in test/cli-pipeline.test.js without editing test/smoke.test.js. Run `node --test test/smoke.test.js test/cli-pipeline.test.js`.',
    ].join('\n'),
    fixture: {
      files: {
        'package.json': JSON.stringify({
          name: 'ar-07-policy-cli',
          version: '1.0.0',
          type: 'module',
          bin: { 'policy-cli': './bin/policy-cli.js' },
        }, null, 2),
        'SPEC.md': [
          '# Policy Manifest Spec',
          '- Lines starting with `#` or whitespace-only are ignored.',
          '- Entries use `KEY = VALUE`; values may be unquoted or single/double quoted.',
          '- Duplicate keys are parse errors (`DUPLICATE_KEY`).',
          '- Required keys: `SERVICE_NAME` (non-empty), `PORT` (int 1..65535), `MODE` (`dev|staging|prod`).',
          '- CLI exit codes: 0 valid, 2 parse/validation failure, 1 CLI/file error.',
          '- `--format json` outputs `{ valid, entries, errors }`.',
        ].join('\n'),
        'src/parser.js': 'export function parseManifest() { throw new Error("not implemented"); }\n',
        'src/validator.js': 'export function validateManifest() { throw new Error("not implemented"); }\n',
        'bin/policy-cli.js': '#!/usr/bin/env node\nprocess.exit(1);\n',
        'test/smoke.test.js': [
          "import test from 'node:test';",
          "import assert from 'node:assert/strict';",
          "import { existsSync } from 'node:fs';",
          "test('spec exists', () => assert.equal(existsSync('SPEC.md'), true));",
        ].join('\n'),
      },
      baselineTestFiles: ['test/smoke.test.js'],
      baselineTestCommand: ['node', '--test', 'test/smoke.test.js'],
    },
    judge: makeAutonomousReasoningJudge({
      requiredSourceFiles: ['src/parser.js', 'src/validator.js', 'bin/policy-cli.js', 'test/cli-pipeline.test.js'],
      hiddenAcceptanceScript: `
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ws = process.env.WORKSPACE_ROOT || process.env.AGENT_US_EVAL_WORKSPACE;

test('hidden acceptance: parser, validator, and CLI exit codes/formats', async () => {
  const { parseManifest } = await import(pathToFileURL(join(ws, 'src/parser.js')).href);
  const { validateManifest } = await import(pathToFileURL(join(ws, 'src/validator.js')).href);

  const ok = parseManifest('# comment\\nSERVICE_NAME = "orders"\\nPORT = 8080\\nMODE = prod\\n');
  assert.equal(ok.errors.length, 0);
  assert.equal(ok.entries.PORT, '8080');
  const valOk = validateManifest(ok, { strict: true });
  assert.equal(valOk.valid, true);

  const dup = parseManifest('SERVICE_NAME = a\\nSERVICE_NAME = b\\nPORT = 80\\nMODE = dev');
  assert.ok(dup.errors.length > 0);

  const tmp = mkdtempSync(join(tmpdir(), 'ar07-cli-'));
  try {
    const validFile = join(tmp, 'valid.pol');
    const badFile = join(tmp, 'bad.pol');
    writeFileSync(validFile, 'SERVICE_NAME = billing\\nPORT = 9090\\nMODE = staging\\n');
    writeFileSync(badFile, 'SERVICE_NAME = billing\\nPORT = 99999\\nMODE = unknown\\nEXTRA = 1\\n');

    const resOk = spawnSync(process.execPath, [join(ws, 'bin/policy-cli.js'), '--file', validFile, '--format', 'json', '--strict'], { encoding: 'utf8' });
    assert.equal(resOk.status, 0, resOk.stderr);
    const parsedOut = JSON.parse(resOk.stdout);
    assert.equal(parsedOut.valid, true);

    const resBad = spawnSync(process.execPath, [join(ws, 'bin/policy-cli.js'), '--file', badFile, '--format', 'json', '--strict'], { encoding: 'utf8' });
    assert.equal(resBad.status, 2);
    const badOut = JSON.parse(resBad.stdout);
    assert.equal(badOut.valid, false);
    assert.ok(badOut.errors.length >= 2);

    const resMissing = spawnSync(process.execPath, [join(ws, 'bin/policy-cli.js')], { encoding: 'utf8' });
    assert.equal(resMissing.status, 1);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
`,
    }),
    metadata: buildMetadata({
      id: 'ar-07-multi-stage-dev',
      area: 'multi_stage_development',
      requiredChangedFiles: ['src/parser.js', 'src/validator.js', 'bin/policy-cli.js', 'test/cli-pipeline.test.js'],
      testFiles: ['test/smoke.test.js', 'test/cli-pipeline.test.js'],
      testCommand: ['node', '--test', 'test/smoke.test.js', 'test/cli-pipeline.test.js'],
      repoFileCount: 6,
      allowWorkspaceNodeCli: true,
    }),
  },

  // 8) ar-08-mid-task-recovery
  {
    id: 'ar-08-mid-task-recovery',
    area: 'mid_task_recovery',
    title: 'Durable Checkpoint & Mid-Execution Interruption Recovery',
    objective: 'Implement atomic checkpointing, fence validation, and idempotent resumption across mid-task crashes.',
    prompt: [
      'Implement crash-resilient stage execution in src/workflow/stage-store.js and src/workflow/checkpoint-runner.js:',
      '1. src/workflow/stage-store.js: loadCheckpoint(workDir), saveCheckpointAtomic(workDir, state) using write-temp + rename with schema { completedStages, fenceToken, stageDigests }.',
      '2. src/workflow/checkpoint-runner.js: executeWithCheckpoint(workDir, stages, { crashAfterStage, fenceToken }) and resumeExecution(workDir, stages, { fenceToken }):',
      '   - Persist checkpoint after each completed stage.',
      '   - Throw Error("CRASH_INTERRUPTED") right after `crashAfterStage` completes.',
      '   - On resumeExecution, validate fenceToken if provided (throwing Error("STALE_FENCE_ERROR") on mismatch), skip already-completed stages so side effects run exactly once, and stay idempotent across repeated resumes.',
      '3. Add test/recovery.test.js without modifying test/baseline-contract.test.js. Run `node --test test/baseline-contract.test.js test/recovery.test.js`.',
    ].join('\n'),
    fixture: {
      files: {
        'package.json': JSON.stringify({ name: 'ar-08-recovery', version: '1.0.0', type: 'module' }, null, 2),
        'src/workflow/stage-store.js': 'export async function loadCheckpoint() { return null; }\nexport async function saveCheckpointAtomic() {}\n',
        'src/workflow/checkpoint-runner.js': 'export async function executeWithCheckpoint() { throw new Error("not implemented"); }\nexport async function resumeExecution() { throw new Error("not implemented"); }\n',
        'test/baseline-contract.test.js': [
          "import test from 'node:test';",
          "import assert from 'node:assert/strict';",
          "import * as runner from '../src/workflow/checkpoint-runner.js';",
          "test('exports recovery entrypoints', () => {",
          "  assert.equal(typeof runner.executeWithCheckpoint, 'function');",
          "  assert.equal(typeof runner.resumeExecution, 'function');",
          '});',
        ].join('\n'),
      },
      baselineTestFiles: ['test/baseline-contract.test.js'],
      baselineTestCommand: ['node', '--test', 'test/baseline-contract.test.js'],
    },
    judge: makeAutonomousReasoningJudge({
      requiredSourceFiles: ['src/workflow/stage-store.js', 'src/workflow/checkpoint-runner.js', 'test/recovery.test.js'],
      rootCauseFiles: ['src/workflow/stage-store.js', 'src/workflow/checkpoint-runner.js'],
      hiddenAcceptanceScript: `
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ws = process.env.WORKSPACE_ROOT || process.env.AGENT_US_EVAL_WORKSPACE;

test('hidden acceptance: crash interruption resumes exactly once and enforces fenceToken', async () => {
  const { executeWithCheckpoint, resumeExecution } = await import(pathToFileURL(join(ws, 'src/workflow/checkpoint-runner.js')).href);
  const { loadCheckpoint } = await import(pathToFileURL(join(ws, 'src/workflow/stage-store.js')).href);

  const workDir = await mkdtemp(join(tmpdir(), 'ar08-run-'));
  const log = [];
  const stages = [
    { id: 'fetch', run: async () => { log.push('fetch'); return 'f1'; } },
    { id: 'build', run: async () => { log.push('build'); return 'b1'; } },
    { id: 'publish', run: async () => { log.push('publish'); return 'p1'; } },
  ];
  try {
    await assert.rejects(
      () => executeWithCheckpoint(workDir, stages, { crashAfterStage: 'build', fenceToken: 'fence-1' }),
      /CRASH_INTERRUPTED/,
    );
    assert.deepEqual(log, ['fetch', 'build']);
    const cp = await loadCheckpoint(workDir);
    assert.deepEqual(cp.completedStages, ['fetch', 'build']);

    await assert.rejects(
      () => resumeExecution(workDir, stages, { fenceToken: 'stale-fence' }),
      /STALE_FENCE_ERROR/,
    );

    const r1 = await resumeExecution(workDir, stages, { fenceToken: 'fence-1' });
    const r2 = await resumeExecution(workDir, stages, { fenceToken: 'fence-1' });
    assert.deepEqual(log, ['fetch', 'build', 'publish']);
    assert.deepEqual(r1.completedStages, ['fetch', 'build', 'publish']);
    assert.deepEqual(r2.completedStages, ['fetch', 'build', 'publish']);
    assert.ok(await readFile(join(workDir, 'checkpoint.json'), 'utf8'));
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});
`,
    }),
    metadata: buildMetadata({
      id: 'ar-08-mid-task-recovery',
      area: 'mid_task_recovery',
      requiredChangedFiles: ['src/workflow/stage-store.js', 'src/workflow/checkpoint-runner.js', 'test/recovery.test.js'],
      testFiles: ['test/baseline-contract.test.js', 'test/recovery.test.js'],
      testCommand: ['node', '--test', 'test/baseline-contract.test.js', 'test/recovery.test.js'],
      repoFileCount: 4,
      recoveryRequirements: true,
    }),
  },

  // 9) ar-09-multi-agent-collab
  {
    id: 'ar-09-multi-agent-collab',
    area: 'multi_agent_collaboration',
    title: 'Swarm Coder+Reviewer Handoff with Digest & Strict Reviewer JSON',
    objective: 'Implement expression tokenizer/evaluator modules, emit SHA-256 artifact handoff manifest, and deliver a digest-bound reviewer JSON verdict.',
    prompt: [
      'Execute a coordinated Coder + Reviewer handoff workflow:',
      '1. Coder implements src/modules/tokenizer.js (`tokenize(expr)`), src/modules/evaluator.js (`evaluateTokens(tokens)` supporting +,-,*,/, parentheses, and throwing on division by zero), and src/index.js (`evaluate(expr)`).',
      '2. Emit handoff/artifacts.json with `{ schemaVersion: "1.0.0", artifacts: [{ path, sha256 }] }` for src/modules/tokenizer.js, src/modules/evaluator.js, and src/index.js, plus handoff/digest.txt containing the SHA-256 over the canonical sorted artifact list.',
      '3. Reviewer emits strict JSON in handoff/reviewer-verdict.json matching schemaVersion "1.0.0", verdict "pass", evidenceDigest equal to handoff/digest.txt, checkedArtifacts listing all 3 paths, findings: [], and readOnlyVerified: true.',
      '4. Add test/collab.test.js without modifying test/collab-baseline.test.js. Run `node --test test/collab-baseline.test.js test/collab.test.js`.',
    ].join('\n'),
    fixture: {
      files: {
        'package.json': JSON.stringify({ name: 'ar-09-collab', version: '1.0.0', type: 'module' }, null, 2),
        'src/modules/tokenizer.js': 'export function tokenize() { return []; }\n',
        'src/modules/evaluator.js': 'export function evaluateTokens() { return 0; }\n',
        'src/index.js': 'export function evaluate() { return 0; }\n',
        'test/collab-baseline.test.js': [
          "import test from 'node:test';",
          "import assert from 'node:assert/strict';",
          "import { evaluate } from '../src/index.js';",
          "test('exports evaluate', () => assert.equal(typeof evaluate, 'function'));",
        ].join('\n'),
      },
      baselineTestFiles: ['test/collab-baseline.test.js'],
      baselineTestCommand: ['node', '--test', 'test/collab-baseline.test.js'],
    },
    judge: makeAutonomousReasoningJudge({
      requiredSourceFiles: [
        'src/modules/tokenizer.js',
        'src/modules/evaluator.js',
        'src/index.js',
        'handoff/artifacts.json',
        'handoff/digest.txt',
        'handoff/reviewer-verdict.json',
        'test/collab.test.js',
      ],
      extraCheck: ({ workspaceRoot }) => {
        const verdictText = readWorkspaceText(workspaceRoot, 'handoff/reviewer-verdict.json');
        const digestText = (readWorkspaceText(workspaceRoot, 'handoff/digest.txt') ?? '').trim();
        const parsed = verdictText ? parseReviewerOutput(verdictText) : { valid: false };
        const artifactsJson = readWorkspaceJson(workspaceRoot, 'handoff/artifacts.json');
        const requiredPaths = ['src/index.js', 'src/modules/evaluator.js', 'src/modules/tokenizer.js'];
        const artifacts = Array.isArray(artifactsJson?.artifacts) ? artifactsJson.artifacts : [];
        const sortedActual = [...artifacts]
          .map((a) => ({ path: normalizeEvidencePath(a.path), sha256: String(a.sha256 ?? '').toLowerCase() }))
          .sort((a, b) => a.path.localeCompare(b.path));
        const hashesOk =
          sortedActual.length === requiredPaths.length &&
          requiredPaths.every((p, i) => {
            const text = readWorkspaceText(workspaceRoot, p);
            return sortedActual[i]?.path === p && text !== null && sortedActual[i].sha256 === sha256Text(text);
          });
        const expectedDigest = sha256Text(JSON.stringify(sortedActual));
        const verdictObj = parsed.parsed;
        return {
          artifactDigestsValid: hashesOk && digestText === expectedDigest,
          reviewerSchemaValid: Boolean(
            parsed.valid &&
              parsed.status === 'pass' &&
              verdictObj?.schemaVersion === REVIEWER_SCHEMA_VERSION &&
              verdictObj?.evidenceDigest === expectedDigest &&
              verdictObj?.readOnlyVerified === true &&
              Array.isArray(verdictObj?.checkedArtifacts) &&
              requiredPaths.every((p) => verdictObj.checkedArtifacts.includes(p)),
          ),
        };
      },
      hiddenAcceptanceScript: `
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ws = process.env.WORKSPACE_ROOT || process.env.AGENT_US_EVAL_WORKSPACE;

test('hidden acceptance: evaluator handles precedence, parentheses, and division by zero', async () => {
  const { evaluate } = await import(pathToFileURL(join(ws, 'src/index.js')).href);
  assert.equal(evaluate('2 + 3 * (4 - 1)'), 11);
  assert.equal(evaluate('(18 / 3) + 4 * 2'), 14);
  assert.throws(() => evaluate('10 / (2 - 2)'), Error);
});

test('hidden acceptance: handoff artifacts digest matches reviewer JSON verdict', () => {
  const artifactsDoc = JSON.parse(readFileSync(join(ws, 'handoff/artifacts.json'), 'utf8'));
  const digest = readFileSync(join(ws, 'handoff/digest.txt'), 'utf8').trim();
  const verdict = JSON.parse(readFileSync(join(ws, 'handoff/reviewer-verdict.json'), 'utf8'));
  const sorted = [...artifactsDoc.artifacts]
    .map((a) => ({ path: a.path, sha256: a.sha256 }))
    .sort((a, b) => a.path.localeCompare(b.path));
  assert.equal(sorted.length, 3);
  for (const entry of sorted) {
    const actual = createHash('sha256').update(readFileSync(join(ws, entry.path), 'utf8')).digest('hex');
    assert.equal(entry.sha256, actual);
  }
  const computed = createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
  assert.equal(digest, computed);
  assert.equal(verdict.schemaVersion, '1.0.0');
  assert.equal(verdict.verdict, 'pass');
  assert.equal(verdict.evidenceDigest, computed);
  assert.equal(verdict.readOnlyVerified, true);
  assert.deepEqual([...verdict.checkedArtifacts].sort(), ['src/index.js', 'src/modules/evaluator.js', 'src/modules/tokenizer.js']);
});
`,
    }),
    metadata: buildMetadata({
      id: 'ar-09-multi-agent-collab',
      area: 'multi_agent_collaboration',
      requiredChangedFiles: [
        'src/modules/tokenizer.js',
        'src/modules/evaluator.js',
        'src/index.js',
        'handoff/artifacts.json',
        'handoff/digest.txt',
        'handoff/reviewer-verdict.json',
        'test/collab.test.js',
      ],
      testFiles: ['test/collab-baseline.test.js', 'test/collab.test.js'],
      testCommand: ['node', '--test', 'test/collab-baseline.test.js', 'test/collab.test.js'],
      repoFileCount: 5,
    }),
  },

  // 10) ar-10-long-horizon-delivery
  {
    id: 'ar-10-long-horizon-delivery',
    area: 'long_horizon_constraint_delivery',
    title: 'Long-Horizon Delivery with Constraint Preservation Under Compaction',
    objective: 'Deliver a multi-step ledger reconciliation & CLI audit pipeline while preserving all 5 constraints across compaction.',
    prompt: [
      'Deliver the ledger reconciliation pipeline while preserving ALL 5 constraints in CONSTRAINTS.md across long-horizon context compaction:',
      '1. CONSTRAINTS.md: (C1) zero runtime npm dependencies, (C2) preserve legacySummary(entries) export in src/core/ledger.js, (C3) deterministic lexicographical account sorting in reconcileLedgers, (C4) pure core modules without fs/process calls in src/core/*, (C5) emit REPORTS/delivery-audit.json attesting all 5 constraint IDs.',
      '2. Implement src/core/ledger.js (`parseEntries`, preserving `legacySummary`), src/core/reconcile.js (`reconcileLedgers`, `formatAuditReport`), and src/cli/audit.js (`--input <file>` outputting sorted JSON report).',
      '3. Generate REPORTS/delivery-audit.json and add test/reconcile.test.js without modifying test/legacy-compat.test.js or CONSTRAINTS.md. Run `node --test test/legacy-compat.test.js test/reconcile.test.js`.',
    ].join('\n'),
    fixture: {
      files: {
        'package.json': JSON.stringify({ name: 'ar-10-ledger', version: '1.0.0', type: 'module' }, null, 2),
        'CONSTRAINTS.md': [
          '# Delivery Constraints (Must Survive Context Compaction)',
          '- C1: Zero runtime dependencies in package.json.',
          '- C2: Preserve legacySummary(entries) export in src/core/ledger.js.',
          '- C3: Deterministic lexicographical sorting of accounts in reconcileLedgers.',
          '- C4: Pure functions in src/core/* (must NOT import node:fs or node:child_process).',
          '- C5: Emit REPORTS/delivery-audit.json listing constraints C1..C5 with verified=true.',
        ].join('\n'),
        'src/core/ledger.js': [
          'export function legacySummary(entries) {',
          '  return entries.reduce((acc, e) => acc + Number(e.amountCents || 0), 0);',
          '}',
          'export function parseEntries(text) { return []; }',
        ].join('\n'),
        'src/core/reconcile.js': 'export function reconcileLedgers() { return { accounts: [], discrepancies: [] }; }\nexport function formatAuditReport(res) { return JSON.stringify(res); }\n',
        'src/cli/audit.js': '#!/usr/bin/env node\nprocess.exit(1);\n',
        'test/legacy-compat.test.js': [
          "import test from 'node:test';",
          "import assert from 'node:assert/strict';",
          "import { legacySummary } from '../src/core/ledger.js';",
          "test('legacySummary remains backwards compatible', () => {",
          '  assert.equal(legacySummary([{ amountCents: 100 }, { amountCents: -25 }]), 75);',
          '});',
        ].join('\n'),
      },
      baselineTestFiles: ['test/legacy-compat.test.js'],
      baselineTestCommand: ['node', '--test', 'test/legacy-compat.test.js'],
    },
    judge: makeAutonomousReasoningJudge({
      requiredSourceFiles: [
        'src/core/ledger.js',
        'src/core/reconcile.js',
        'src/cli/audit.js',
        'REPORTS/delivery-audit.json',
        'test/reconcile.test.js',
      ],
      protectedReadOnlyFiles: ['CONSTRAINTS.md'],
      extraCheck: ({ workspaceRoot }) => {
        const ledgerSrc = readWorkspaceText(workspaceRoot, 'src/core/ledger.js') ?? '';
        const reconcileSrc = readWorkspaceText(workspaceRoot, 'src/core/reconcile.js') ?? '';
        const auditJson = readWorkspaceJson(workspaceRoot, 'REPORTS/delivery-audit.json');
        const pkg = readWorkspaceJson(workspaceRoot, 'package.json');
        const c1 = !pkg?.dependencies || Object.keys(pkg.dependencies).length === 0;
        const c2 = /export\s+function\s+legacySummary/.test(ledgerSrc);
        const c4 = !/node:fs|node:child_process/.test(ledgerSrc) && !/node:fs|node:child_process/.test(reconcileSrc);
        const c5 = Boolean(
          auditJson &&
            ['C1', 'C2', 'C3', 'C4', 'C5'].every((id) => auditJson.constraints?.[id]?.verified === true),
        );
        return {
          constraintsPreserved: c1 && c2 && c4 && c5,
        };
      },
      hiddenAcceptanceScript: `
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ws = process.env.WORKSPACE_ROOT || process.env.AGENT_US_EVAL_WORKSPACE;

test('hidden acceptance: reconciliation, CLI, and all 5 constraints survive compaction', async () => {
  const { legacySummary, parseEntries } = await import(pathToFileURL(join(ws, 'src/core/ledger.js')).href);
  const { reconcileLedgers, formatAuditReport } = await import(pathToFileURL(join(ws, 'src/core/reconcile.js')).href);

  assert.equal(legacySummary([{ amountCents: 300 }, { amountCents: -50 }]), 250);
  const left = parseEntries('zebra,100\\nalpha,250\\nalpha,-50\\n');
  const right = parseEntries('alpha,200\\nbeta,90\\n');
  const rec = reconcileLedgers(left, right);
  assert.deepEqual(rec.accounts.map((a) => a.account), ['alpha', 'beta', 'zebra']);
  assert.deepEqual(rec.discrepancies.map((d) => d.account), ['beta', 'zebra']);
  assert.ok(JSON.parse(formatAuditReport(rec)).accounts);

  const ledgerSrc = readFileSync(join(ws, 'src/core/ledger.js'), 'utf8');
  const reconcileSrc = readFileSync(join(ws, 'src/core/reconcile.js'), 'utf8');
  assert.ok(!/node:fs|node:child_process/.test(ledgerSrc));
  assert.ok(!/node:fs|node:child_process/.test(reconcileSrc));

  const audit = JSON.parse(readFileSync(join(ws, 'REPORTS/delivery-audit.json'), 'utf8'));
  for (const cid of ['C1', 'C2', 'C3', 'C4', 'C5']) {
    assert.equal(audit.constraints?.[cid]?.verified, true, 'missing constraint verification for ' + cid);
  }

  const tmp = mkdtempSync(join(tmpdir(), 'ar10-cli-'));
  try {
    const inFile = join(tmp, 'entries.json');
    writeFileSync(inFile, JSON.stringify({ left, right }));
    const cliRes = spawnSync(process.execPath, [join(ws, 'src/cli/audit.js'), '--input', inFile], { encoding: 'utf8' });
    assert.equal(cliRes.status, 0, cliRes.stderr);
    const out = JSON.parse(cliRes.stdout);
    assert.deepEqual(out.accounts.map((a) => a.account), ['alpha', 'beta', 'zebra']);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
`,
    }),
    metadata: buildMetadata({
      id: 'ar-10-long-horizon-delivery',
      area: 'long_horizon_constraint_delivery',
      requiredChangedFiles: [
        'src/core/ledger.js',
        'src/core/reconcile.js',
        'src/cli/audit.js',
        'REPORTS/delivery-audit.json',
        'test/reconcile.test.js',
      ],
      testFiles: ['test/legacy-compat.test.js', 'test/reconcile.test.js'],
      testCommand: ['node', '--test', 'test/legacy-compat.test.js', 'test/reconcile.test.js'],
      repoFileCount: 6,
      allowWorkspaceNodeCli: true,
    }),
  },
].map((raw) => {
  const baselineFileHashes = computeFileHashes(raw.fixture.files, [
    ...(raw.fixture.baselineTestFiles ?? []),
    ...Object.keys(raw.fixture.files).filter((p) => p === 'CONSTRAINTS.md' || p === 'SPEC.md'),
  ]);
  const repoFileCount = Object.keys(raw.fixture.files).length;
  const budgetPlan = estimateTaskBudget({
    taskType: raw.id,
    fileCount: repoFileCount,
    requiredTools: ['read_file', 'write_file', 'edit_file', 'bash'],
    expectedArtifacts: raw.metadata.expectedArtifacts,
    verificationComplexity: 'high',
    recoveryRequirements: Boolean(raw.metadata.recoveryRequirements),
  });
  const resourceBudget = {
    maxSteps: Math.max(20, budgetPlan.maxSteps),
    maxTokens: budgetPlan.estimatedTokens,
    finalVerificationReserve: budgetPlan.finalVerificationReserve,
    maxDurationMs: Math.max(60_000, budgetPlan.maxSteps * 5_000),
    breakdown: {
      planningSteps: budgetPlan.planningSteps,
      researchSteps: budgetPlan.researchSteps,
      implementationSteps: budgetPlan.implementationSteps,
      testingSteps: budgetPlan.testingSteps,
      reviewSteps: budgetPlan.reviewSteps,
      repairReserve: budgetPlan.repairReserve,
      finalVerificationReserve: budgetPlan.finalVerificationReserve,
    },
    suggestedStages: budgetPlan.suggestedStages,
  };
  return {
    ...raw,
    category: 'autonomous-reasoning-2.4',
    difficulty: 'hard',
    tags: ['benchmark', 'autonomous-reasoning', '2.4', raw.area],
    fixture: {
      ...raw.fixture,
      baselineFileHashes,
      baselineDigest: sha256Text(JSON.stringify(raw.fixture.files)),
    },
    prompt: `${raw.prompt}\n\n${formatEvidenceManifestContract({
      taskId: raw.id,
      attemptId: 'attempt-1',
      planVersion: 1,
      testCommand: raw.metadata.acceptanceCriteria.testCommand,
      requiredChangedFiles: raw.metadata.acceptanceCriteria.requiredChangedFiles,
    })}`,
    resourceBudget,
    metadata: {
      ...raw.metadata,
      resourceBudget,
    },
    expected: {
      output: {
        taskId: raw.id,
        evidenceRequired: true,
        schemaVersion: EVIDENCE_MANIFEST_SCHEMA_VERSION,
      },
    },
  };
});

export const AUTONOMOUS_REASONING_DATASET = Object.freeze(RAW_TASKS);

export function createAutonomousReasoningDataset({
  sandbox = null,
  sandboxOptions = null,
  repoOverrides = null,
} = {}) {
  const datasetSandbox =
    sandbox ?? (sandboxOptions ? new BenchmarkSandbox(sandboxOptions) : getDefaultBenchmarkSandbox());
  return RAW_TASKS.map((task) => {
    const override =
      repoOverrides && typeof repoOverrides === 'object' ? repoOverrides[task.id] ?? null : null;
    const baseFixture = structuredClone(task.fixture);
    const fixture = {
      ...baseFixture,
      ...(override?.repoUrl ? { repoUrl: override.repoUrl } : {}),
      ...(override?.commit ? { commit: override.commit } : {}),
      ...(override?.cacheDir ? { cacheDir: override.cacheDir } : {}),
    };
    return {
      ...task,
      judge: ({ task: t, output, context = {} }) =>
        task.judge({
          task: t,
          output,
          context: context?.sandbox ? context : { ...context, sandbox: datasetSandbox },
        }),
      fixture,
      expected: structuredClone(task.expected),
      metadata: structuredClone(task.metadata),
    };
  });
}

/**
 * Materializes deterministic pinned bare git repositories for all 10 tasks so
 * callers can exercise `createGitRepoWorkspace` with exact 40-char commit SHAs.
 */
export async function materializeAutonomousReasoningRepos(rootDir, { tasks = RAW_TASKS } = {}) {
  const baseRoot = resolve(String(rootDir));
  mkdirSync(baseRoot, { recursive: true });
  const repoOverrides = {};
  const entries = await Promise.all(
    tasks.map(async (task) => {
      const work = join(baseRoot, `${task.id}-src`);
      const bare = join(baseRoot, `${task.id}.git`);
      rmSync(work, { recursive: true, force: true });
      rmSync(bare, { recursive: true, force: true });
      mkdirSync(work, { recursive: true });
      const fileEntries = Object.entries(task.fixture.files).sort(([a], [b]) => a.localeCompare(b));
      for (const [rel, body] of fileEntries) {
        const abs = join(work, rel);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, String(body), 'utf8');
      }
      const run = async (args, cwd = work) => {
        const res = await runHardenedGit(args, { cwd, allowNetwork: false });
        if (res.error || res.exitCode !== 0) {
          throw new Error(res.stderr?.trim() || `git ${args[0]} failed for ${task.id}`);
        }
        return res.stdout.trim();
      };
      await run(['init', '-q', '--initial-branch=main']);
      await run(['config', 'core.filemode', 'false']);
      await run(['config', 'core.autocrlf', 'false']);
      await run(['config', 'user.email', 'fixture@agent-us.invalid']);
      await run(['config', 'user.name', 'Agent_US Fixture']);
      await run(['add', '--all']);
      await run(['commit', '--date=2025-01-01T00:00:00Z', '-qm', `Freeze ${task.id} baseline`]);
      const commit = (await run(['rev-parse', 'HEAD'])).toLowerCase();
      await run(['clone', '--quiet', '--bare', work, bare], baseRoot);
      rmSync(work, { recursive: true, force: true });
      return [task.id, { repoUrl: pathToFileURL(bare).href, commit }];
    }),
  );
  for (const [taskId, info] of entries) {
    repoOverrides[taskId] = info;
  }
  return {
    repoOverrides,
    cleanup: () => rmSync(baseRoot, { recursive: true, force: true }),
  };
}

/**
 * Instantiates an isolated frozen git workspace for a task and locks `core.filemode=false`
 * so cross-platform Docker bind mounts never report spurious permission diffs.
 */
export async function instantiateAutonomousReasoningWorkspace(task, options = {}) {
  const workspaceRoot = await createFixtureWorkspace(task, options);
  runHardenedGitSync(['config', 'core.filemode', 'false'], { cwd: workspaceRoot, allowNetwork: false });
  return workspaceRoot;
}

// ---------------------------------------------------------------------------
// 9-Metric + 3-Way Attribution Engine
// ---------------------------------------------------------------------------

function resolveBoolean(val, fallback) {
  return typeof val === 'boolean' ? val : fallback;
}

function extractTrialTokens(trial) {
  const tu =
    trial?.tokenUsage ??
    trial?.telemetry?.tokenUsage ??
    trial?.usage ??
    null;
  const inputTokens = Number(tu?.inputTokens ?? tu?.input ?? 0) || 0;
  const outputTokens = Number(tu?.outputTokens ?? tu?.output ?? 0) || 0;
  const cacheReadTokens = Number(tu?.cacheReadTokens ?? 0) || 0;
  const explicitTotal = Number(trial?.tokenCost ?? tu?.totalTokens ?? 0);
  const totalTokens = Number.isFinite(explicitTotal) && explicitTotal > 0
    ? explicitTotal
    : inputTokens + outputTokens;
  return { inputTokens, outputTokens, cacheReadTokens, totalTokens };
}

function normalizeTrialRecord(raw) {
  const trial = raw && typeof raw === 'object' ? raw : {};
  const ev = trial?.judge?.evidence ?? trial?.evidence ?? {};
  const checks = ev?.checks ?? {};
  const rm = trial?.reasoningMetrics ?? trial?.telemetry?.reasoningMetrics ?? {};

  const passed = Boolean(
    trial.passed === true &&
      trial.hardVetoed !== true &&
      trial?.judge?.hardVetoed !== true &&
      (trial.status === undefined || trial.status === 'passed') &&
      ev?.hiddenAcceptancePassed !== false &&
      ev?.baselineTestsUntampered !== false &&
      ev?.historyUntouched !== false,
  );
  const status = String(trial.status ?? (passed ? 'passed' : 'failed'));

  const rootCauseAccurate = resolveBoolean(
    trial.rootCauseAccurate ??
      trial.rootCauseCorrect ??
      ev?.rootCauseMatch ??
      checks?.rootCauseMatch ??
      rm?.rootCauseLocalized,
    passed,
  );

  const attempts = Math.max(1, Number(trial.attempts ?? 1) || 1);
  const repairRounds = Number(trial.repairRounds ?? rm?.repairRounds ?? 0) || 0;
  const retries = Number(trial.retries ?? trial?.telemetry?.retries ?? Math.max(0, attempts - 1)) || 0;
  const firstFixSucceeded = resolveBoolean(
    trial.firstFixSucceeded ?? trial.firstFixPassed ?? rm?.firstFixSucceeded,
    passed && attempts === 1 && repairRounds === 0 && retries === 0,
  );

  const regressionPassed = resolveBoolean(
    trial.regressionPassed ?? ev?.regressionPassed,
    ev?.baselineTestsUntampered !== false &&
      (ev?.baselineTestExitCode === 0 || (ev?.baselineTestExitCode === undefined && passed)) &&
      (ev?.actualTestExitCode === 0 || (ev?.actualTestExitCode === undefined && passed)),
  );

  const ineffectiveActionCount = Math.max(
    0,
    Number(
      trial.ineffectiveActionCount ??
        trial.ineffectiveActions ??
        rm?.ineffectiveActionCount ??
        0,
    ) || 0,
  );

  const replanTriggered = Boolean(
    trial.replanTriggered ||
      Number(trial.replanCount ?? rm?.replanCount ?? 0) > 0,
  );
  const replanSucceeded = Boolean(
    replanTriggered &&
      resolveBoolean(trial.replanSucceeded, passed),
  );

  const isRecoveryTask = Boolean(
    trial.isRecoveryTask ||
      trial.recoveryAttempted ||
      /recovery/i.test(String(trial.taskId ?? ev?.taskId ?? '')),
  );
  const recoverySucceeded = Boolean(
    isRecoveryTask &&
      resolveBoolean(trial.recoverySucceeded ?? trial.recovered, passed),
  );

  const durationMs = Math.max(0, Number(trial.durationMs ?? trial.wallMs ?? 0) || 0);
  const tokens = extractTrialTokens(trial);
  const failureCategory = passed
    ? 'none'
    : String(trial.failureCategory ?? ev?.failureCategory ?? (status === 'timeout' ? 'timeout' : 'failed'));
  const attribution = passed
    ? FAILURE_ATTRIBUTIONS.NONE
    : classifyAutonomousReasoningAttribution({
        ...trial,
        passed,
        status,
        failureCategory,
        evidence: ev,
      });

  return {
    taskId: String(trial.taskId ?? ev?.taskId ?? 'unknown'),
    category: String(trial.category ?? ev?.category ?? 'autonomous-reasoning-2.4'),
    status,
    passed,
    rootCauseAccurate,
    firstFixSucceeded,
    regressionPassed,
    ineffectiveActionCount,
    replanTriggered,
    replanSucceeded,
    isRecoveryTask,
    recoverySucceeded,
    tokenCost: tokens.totalTokens,
    tokens,
    durationMs,
    failureCategory,
    attribution,
  };
}

/**
 * Computes all 9 required autonomous reasoning metrics and 3-way failure attribution
 * while retaining 100% of failed/timedOut/cancelled trials.
 */
export function computeAutonomousReasoningMetrics(trials = []) {
  const input = Array.isArray(trials) ? trials : [];
  const normalized = input.map(normalizeTrialRecord);
  const totalTrials = normalized.length;
  const passedTrials = normalized.filter((t) => t.passed).length;
  const failedTrials = totalTrials - passedTrials;

  const replanTrials = normalized.filter((t) => t.replanTriggered);
  const replanSucceededCount = replanTrials.filter((t) => t.replanSucceeded).length;

  const recoveryTrials = normalized.filter((t) => t.isRecoveryTask);
  const recoverySucceededCount = recoveryTrials.filter((t) => t.recoverySucceeded).length;

  const totalIneffectiveActions = normalized.reduce((s, t) => s + t.ineffectiveActionCount, 0);
  const totalTokens = normalized.reduce((s, t) => s + t.tokens.totalTokens, 0);
  const totalInputTokens = normalized.reduce((s, t) => s + t.tokens.inputTokens, 0);
  const totalOutputTokens = normalized.reduce((s, t) => s + t.tokens.outputTokens, 0);
  const totalCacheReadTokens = normalized.reduce((s, t) => s + t.tokens.cacheReadTokens, 0);
  const totalDurationMs = normalized.reduce((s, t) => s + t.durationMs, 0);

  const attributionCounts = {
    [FAILURE_ATTRIBUTIONS.TOOL_MECHANISM]: 0,
    [FAILURE_ATTRIBUTIONS.MODEL_CAPABILITY]: 0,
    [FAILURE_ATTRIBUTIONS.RUNTIME_RELIABILITY]: 0,
    [FAILURE_ATTRIBUTIONS.NONE]: 0,
  };
  const failureTaxonomy = {};

  for (const t of normalized) {
    attributionCounts[t.attribution] = (attributionCounts[t.attribution] ?? 0) + 1;
    if (!t.passed) {
      failureTaxonomy[t.failureCategory] = (failureTaxonomy[t.failureCategory] ?? 0) + 1;
    }
  }

  const attributionBreakdown = Object.fromEntries(
    Object.entries(attributionCounts).map(([key, count]) => [
      key,
      { count, rate: totalTrials ? round4(count / totalTrials) : 0 },
    ]),
  );

  return {
    benchmarkId: AUTONOMOUS_REASONING_BENCHMARK_ID,
    version: VERSION,
    totalTrials,
    passedTrials,
    failedTrials,
    // 9 required metrics:
    finalTaskSuccessRate: totalTrials ? round4(passedTrials / totalTrials) : 0,
    rootCauseAccuracy: totalTrials
      ? round4(normalized.filter((t) => t.rootCauseAccurate).length / totalTrials)
      : 0,
    firstFixSuccessRate: totalTrials
      ? round4(normalized.filter((t) => t.firstFixSucceeded).length / totalTrials)
      : 0,
    regressionTestPassRate: totalTrials
      ? round4(normalized.filter((t) => t.regressionPassed).length / totalTrials)
      : 0,
    ineffectiveActionCount: totalIneffectiveActions,
    replanEffectivenessRate: replanTrials.length
      ? round4(replanSucceededCount / replanTrials.length)
      : 0,
    tokenCost: totalTokens,
    meanDurationMs: totalTrials ? Math.round(totalDurationMs / totalTrials) : 0,
    recoverySuccessRate: recoveryTrials.length
      ? round4(recoverySucceededCount / recoveryTrials.length)
      : 0,
    // 3-way attribution breakdown:
    attributionBreakdown,
    attributionCounts,
    tokenBreakdown: {
      totalTokens,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      cacheReadTokens: totalCacheReadTokens,
      meanTokensPerTrial: totalTrials ? Math.round(totalTokens / totalTrials) : 0,
    },
    meanIneffectiveActionsPerTrial: totalTrials ? round4(totalIneffectiveActions / totalTrials) : 0,
    replanTrialsCount: replanTrials.length,
    replanSucceededCount,
    recoveryTrialsCount: recoveryTrials.length,
    recoverySucceededCount,
    failureTaxonomy,
    trials: normalized,
  };
}

// ---------------------------------------------------------------------------
// Reference Solutions (kept separate from task definitions so prompts never leak)
// ---------------------------------------------------------------------------

export function getAutonomousReasoningReferenceFix(taskId, workspaceRoot = null) {
  switch (taskId) {
    case 'ar-01-unfamiliar-codebase': {
      const contract = {
        entryPoint: 'src/index.js',
        port: 8420,
        rateLimit: 25,
        authHeader: 'x-tenant-token',
        precedence: ['env', 'profile', 'defaults'],
        routes: [
          { path: '/v2/orders', handler: 'ordersHandler', middlewares: ['auth', 'rate-limit'] },
          { path: '/healthz', handler: 'healthHandler', middlewares: [] },
        ],
        sources: [
          'src/config/defaults.js',
          'src/config/env-loader.js',
          'src/index.js',
          'src/pipeline/registry.js',
          'src/pipeline/stages/auth.js',
          'src/pipeline/stages/rate-limit.js',
          'src/server/router.js',
        ],
      };
      return {
        'CONTRACT.json': JSON.stringify(contract, null, 2) + '\n',
        'ANALYSIS.md': [
          '# Effective Contract Analysis',
          '- Entry point `src/index.js` loads configuration from `src/config/env-loader.js`, which merges `src/config/defaults.js` with `PROFILE_OVERRIDES.prod` and explicit `env` overrides (`env > profile > defaults` precedence).',
          '- `src/server/router.js` attaches stages built by `src/pipeline/registry.js`, combining `src/pipeline/stages/auth.js` (`x-tenant-token`) and `src/pipeline/stages/rate-limit.js` (`rateLimit=25`) on `/v2/orders`, leaving `/healthz` public.',
        ].join('\n') + '\n',
      };
    }

    case 'ar-02-complex-bug-root-cause':
      return {
        'src/pricing/currency.js': [
          'export function toMinorUnits(dollars) {',
          '  const n = Number(dollars);',
          '  return Math.round((n + Math.sign(n) * 1e-12) * 100);',
          '}',
          'export function allocateProportional(totalCents, weights) {',
          '  const sum = weights.reduce((a, b) => a + b, 0);',
          '  if (sum <= 0) return weights.map(() => 0);',
          '  const exact = weights.map((w, idx) => {',
          '    const raw = (totalCents * w) / sum;',
          '    const floor = Math.floor(raw);',
          '    return { idx, floor, rem: raw - floor };',
          '  });',
          '  let remainder = totalCents - exact.reduce((s, e) => s + e.floor, 0);',
          '  const sorted = [...exact].sort((a, b) => b.rem - a.rem || a.idx - b.idx);',
          '  const out = exact.map((e) => e.floor);',
          '  for (let i = 0; i < remainder; i++) out[sorted[i].idx] += 1;',
          '  return out;',
          '}',
        ].join('\n') + '\n',
        'src/pricing/discount.js': [
          "import { allocateProportional } from './currency.js';",
          'export function applyDiscount(items, coupon) {',
          '  const pct = Math.min(100, Math.max(0, Number(coupon?.percent ?? 0) || 0));',
          '  const grossList = items.map((item) => item.priceCents * item.qty);',
          '  const subtotalCents = grossList.reduce((s, g) => s + g, 0);',
          '  const discountedSubtotalCents = Math.round(subtotalCents * (1 - pct / 100));',
          '  const allocs = allocateProportional(discountedSubtotalCents, grossList);',
          '  const lines = items.map((item, i) => ({ ...item, grossCents: grossList[i], discountedCents: allocs[i] }));',
          '  return { lines, subtotalCents, discountedSubtotalCents };',
          '}',
        ].join('\n') + '\n',
        'src/pricing/tax.js': [
          'const RATES = Object.freeze({ US: 0.08, EU: 0.2 });',
          'export function computeTax(lines, region = "US") {',
          '  const rate = RATES[region] ?? 0;',
          '  const taxableCents = lines.reduce((sum, line) => sum + (line.taxExempt ? 0 : (line.discountedCents ?? line.grossCents)), 0);',
          '  return Math.round(taxableCents * rate);',
          '}',
        ].join('\n') + '\n',
        'test/root-cause.test.js': [
          "import test from 'node:test';",
          "import assert from 'node:assert/strict';",
          "import { toMinorUnits, allocateProportional } from '../src/pricing/currency.js';",
          "import { checkout } from '../src/pricing/checkout.js';",
          "test('fixes currency allocation and post-discount tax root causes', () => {",
          '  assert.equal(toMinorUnits(19.99), 1999);',
          '  assert.deepEqual(allocateProportional(100, [1, 1, 1]), [34, 33, 33]);',
          '  const res = checkout({ items: [{ priceCents: 1000, qty: 1 }, { priceCents: 500, qty: 1, taxExempt: true }], coupon: { percent: 20 }, region: "EU" });',
          '  assert.equal(res.totalCents, 1360);',
          '});',
        ].join('\n') + '\n',
      };

    case 'ar-03-multi-file-feature':
      return {
        'src/query/filter.js': [
          'export function matchesWhere(record, where = {}) {',
          '  if (!where || typeof where !== "object") return true;',
          '  for (const [key, cond] of Object.entries(where)) {',
          '    const val = record?.[key];',
          '    if (cond && typeof cond === "object" && !Array.isArray(cond)) {',
          '      if (cond.gte !== undefined && !(val >= cond.gte)) return false;',
          '      if (cond.lte !== undefined && !(val <= cond.lte)) return false;',
          '      if (Array.isArray(cond.in) && !cond.in.includes(val)) return false;',
          '    } else if (val !== cond) {',
          '      return false;',
          '    }',
          '  }',
          '  return true;',
          '}',
        ].join('\n') + '\n',
        'src/query/paginate.js': [
          'export function encodeCursor(payload) {',
          '  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");',
          '}',
          'export function decodeCursor(cursor) {',
          '  if (typeof cursor !== "string" || !cursor.trim() || !/^[A-Za-z0-9_-]+$/.test(cursor)) {',
          '    throw new TypeError("Invalid cursor");',
          '  }',
          '  let parsed;',
          '  try {',
          '    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));',
          '  } catch { throw new TypeError("Invalid cursor JSON"); }',
          '  if (!parsed || typeof parsed !== "object" || parsed.id === undefined) throw new TypeError("Malformed cursor payload");',
          '  return parsed;',
          '}',
          'export function paginateRecords(records, { sortBy = "id", order = "asc", cursor = null, limit = 10 } = {}) {',
          '  const dir = order === "desc" ? -1 : 1;',
          '  const capped = Math.max(1, Math.min(100, Number(limit) || 10));',
          '  const sorted = [...records].sort((a, b) => {',
          '    const va = a?.[sortBy];',
          '    const vb = b?.[sortBy];',
          '    if (va < vb) return -1 * dir;',
          '    if (va > vb) return 1 * dir;',
          '    return String(a?.id ?? "").localeCompare(String(b?.id ?? ""));',
          '  });',
          '  let start = 0;',
          '  if (cursor !== null && cursor !== undefined) {',
          '    const cur = decodeCursor(cursor);',
          '    const idx = sorted.findIndex((r) => String(r.id) === String(cur.id));',
          '    if (idx < 0) throw new TypeError("Cursor id not found");',
          '    start = idx + 1;',
          '  }',
          '  const items = sorted.slice(start, start + capped);',
          '  const hasMore = start + capped < sorted.length;',
          '  const last = items.at(-1);',
          '  return { items, nextCursor: hasMore && last ? encodeCursor({ id: last.id, sortValue: last[sortBy] }) : null };',
          '}',
        ].join('\n') + '\n',
        'src/store/memory-store.js': [
          "import { matchesWhere } from '../query/filter.js';",
          "import { paginateRecords } from '../query/paginate.js';",
          'export class MemoryStore {',
          '  constructor(initial = []) { this.records = [...initial]; }',
          '  insert(rec) { this.records.push(rec); return rec; }',
          '  all() { return [...this.records]; }',
          '  query(options = {}) {',
          '    const filtered = this.records.filter((r) => matchesWhere(r, options.where));',
          '    return paginateRecords(filtered, options);',
          '  }',
          '}',
        ].join('\n') + '\n',
        'src/index.js': [
          "export { MemoryStore } from './store/memory-store.js';",
          "export { matchesWhere } from './query/filter.js';",
          "export { encodeCursor, decodeCursor, paginateRecords } from './query/paginate.js';",
          'export function queryRecords(store, options = {}) { return store.query(options); }',
        ].join('\n') + '\n',
        'test/query-pagination.test.js': [
          "import test from 'node:test';",
          "import assert from 'node:assert/strict';",
          "import { MemoryStore, queryRecords, decodeCursor } from '../src/index.js';",
          "test('paginated query handles filters, cursors, and errors', () => {",
          '  const s = new MemoryStore([{ id: "1", v: 2 }, { id: "2", v: 1 }, { id: "3", v: 3 }]);',
          '  const p1 = queryRecords(s, { sortBy: "v", order: "asc", limit: 2 });',
          '  assert.deepEqual(p1.items.map((r) => r.id), ["2", "1"]);',
          '  const p2 = s.query({ sortBy: "v", order: "asc", cursor: p1.nextCursor, limit: 2 });',
          '  assert.deepEqual(p2.items.map((r) => r.id), ["3"]);',
          '  assert.throws(() => decodeCursor("bad!"), TypeError);',
          '});',
        ].join('\n') + '\n',
      };

    case 'ar-04-cross-module-refactor':
      return {
        'src/shared/record-normalizer.js': [
          'export function sanitizeField(value) {',
          '  return String(value ?? "").replace(/[\\r\\n\\t]+/g, " ").trim();',
          '}',
          'export function canonicalizeRecord(raw = {}, columns = Object.keys(raw ?? {})) {',
          '  const lowered = {};',
          '  for (const [k, v] of Object.entries(raw ?? {})) {',
          '    lowered[sanitizeField(k).toLowerCase()] = sanitizeField(v);',
          '  }',
          '  const out = {};',
          '  for (const col of columns) {',
          '    const normCol = sanitizeField(col).toLowerCase();',
          '    out[normCol] = lowered[normCol] ?? "";',
          '  }',
          '  return out;',
          '}',
          'export function stableColumns(records = []) {',
          '  const keys = new Set();',
          '  for (const r of records) {',
          '    for (const k of Object.keys(r ?? {})) keys.add(sanitizeField(k).toLowerCase());',
          '  }',
          '  return [...keys].sort();',
          '}',
        ].join('\n') + '\n',
        'src/ingest/csv-reader.js': [
          "import { sanitizeField } from '../shared/record-normalizer.js';",
          'export function parseCsvRow(headers, values) {',
          '  const rec = {};',
          '  for (let i = 0; i < headers.length; i++) rec[sanitizeField(headers[i]).toLowerCase()] = sanitizeField(values[i]);',
          '  return rec;',
          '}',
        ].join('\n') + '\n',
        'src/export/tsv-writer.js': [
          "import { sanitizeField } from '../shared/record-normalizer.js';",
          'export function formatTsvRow(record, columns) {',
          '  const cols = [...columns].sort();',
          '  return cols.map((c) => sanitizeField(record[c.toLowerCase()] ?? record[c])).join("\\t");',
          '}',
        ].join('\n') + '\n',
        'src/audit/report-formatter.js': [
          "import { sanitizeField, stableColumns } from '../shared/record-normalizer.js';",
          'export function formatAuditEntry(record) {',
          '  const keys = stableColumns([record]);',
          '  return keys.map((k) => `${k}=${sanitizeField(record[k] ?? record[k.toUpperCase()])}`).join("; ");',
          '}',
        ].join('\n') + '\n',
        'test/normalizer.test.js': [
          "import test from 'node:test';",
          "import assert from 'node:assert/strict';",
          "import { sanitizeField, canonicalizeRecord, stableColumns } from '../src/shared/record-normalizer.js';",
          "test('shared normalizer works across helpers', () => {",
          '  assert.equal(sanitizeField(" hi\\n\\tthere "), "hi there");',
          '  assert.deepEqual(stableColumns([{ b: 1, a: 2 }]), ["a", "b"]);',
          '  assert.deepEqual(canonicalizeRecord({ " X ": " 1 " }, ["x", "y"]), { x: "1", y: "" });',
          '});',
        ].join('\n') + '\n',
      };

    case 'ar-05-security-vuln-fix':
      return {
        'src/fs/safe-bundle.js': [
          "import { lstatSync, readlinkSync, realpathSync } from 'node:fs';",
          "import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';",
          'function realExisting(p) {',
          '  const realFn = typeof realpathSync.native === "function" ? realpathSync.native : realpathSync;',
          '  let cur = resolve(p);',
          '  for (let i = 0; i < 16; i++) {',
          '    try { return realFn(cur); } catch (err) {',
          '      if (err?.code !== "ENOENT" && err?.code !== "ENOTDIR") throw err;',
          '      let lst = null;',
          '      try { lst = lstatSync(cur); } catch { lst = null; }',
          '      if (lst?.isSymbolicLink()) {',
          '        const target = readlinkSync(cur);',
          '        cur = isAbsolute(target) ? resolve(target) : resolve(dirname(cur), target);',
          '        continue;',
          '      }',
          '      const parent = dirname(cur);',
          '      if (parent === cur) return cur;',
          '      const tail = relative(parent, cur);',
          '      return join(realExisting(parent), tail);',
          '    }',
          '  }',
          '  throw new Error("Symlink depth exceeded");',
          '}',
          'export function resolveBundlePath(rootDir, entryPath) {',
          '  const raw = String(entryPath ?? "");',
          '  if (!raw || raw.includes("\\0") || /%2e/i.test(raw) || /^[a-zA-Z]:/.test(raw) || raw.startsWith("/") || raw.startsWith("\\\\")) {',
          '    throw new Error("Unsafe entry path");',
          '  }',
          '  const normalized = raw.replaceAll("\\\\", "/");',
          '  if (normalized.split("/").some((seg) => seg === "..")) throw new Error("Path traversal blocked");',
          '  const realRoot = realExisting(rootDir);',
          '  const realTarget = realExisting(resolve(realRoot, normalized));',
          '  const rel = relative(realRoot, realTarget);',
          '  if (!rel || rel === ".." || rel.startsWith(".." + sep) || rel.startsWith("../") || isAbsolute(rel)) {',
          '    throw new Error("Path escapes rootDir");',
          '  }',
          '  return realTarget;',
          '}',
        ].join('\n') + '\n',
        'src/config/deep-merge.js': [
          'const BLOCKED_KEYS = new Set(["__proto__", "constructor", "prototype"]);',
          'function isPlainObject(v) { return Boolean(v) && typeof v === "object" && !Array.isArray(v); }',
          'export function mergeConfig(target, source) {',
          '  const out = isPlainObject(target) ? { ...target } : {};',
          '  if (!isPlainObject(source)) return out;',
          '  for (const key of Object.keys(source)) {',
          '    if (BLOCKED_KEYS.has(key)) continue;',
          '    const val = source[key];',
          '    out[key] = isPlainObject(val) ? mergeConfig(isPlainObject(out[key]) ? out[key] : {}, val) : val;',
          '  }',
          '  return out;',
          '}',
        ].join('\n') + '\n',
        'SECURITY.md': [
          '# Security Remediation Report',
          '1. Path Traversal & Symlink Escape in `src/fs/safe-bundle.js`: blocked NUL bytes, encoded dots, backslashes, drive prefixes, and canonicalized symlink paths inside `rootDir`.',
          '2. Prototype Pollution in `src/config/deep-merge.js`: filtered `__proto__`, `constructor`, and `prototype` keys recursively.',
        ].join('\n') + '\n',
        'test/security-regression.test.js': [
          "import test from 'node:test';",
          "import assert from 'node:assert/strict';",
          "import { resolveBundlePath, mergeConfig } from '../src/index.js';",
          "test('blocks traversal and prototype pollution', () => {",
          '  assert.throws(() => resolveBundlePath(process.cwd(), "../evil"));',
          '  mergeConfig({}, JSON.parse(\'{"__proto__":{"polluted":true}}\'));',
          '  assert.equal(({}).polluted, undefined);',
          '});',
        ].join('\n') + '\n',
      };

    case 'ar-06-test-failure-repair':
      return {
        'src/scheduler/backoff.js': [
          'export function computeBackoffMs(attempt, { baseMs = 200, maxMs = 10000, jitterRatio = 0 } = {}) {',
          '  const safeBase = Math.max(0, Number(baseMs) || 0);',
          '  const safeMax = Math.max(safeBase, Number(maxMs) || 0);',
          '  const n = Number.isFinite(Number(attempt)) ? Math.max(0, Math.floor(Number(attempt))) : 0;',
          '  const exp = Math.min(30, n);',
          '  const raw = Math.min(safeMax, safeBase * (2 ** exp));',
          '  const jr = Math.min(1, Math.max(0, Number(jitterRatio) || 0));',
          '  if (jr === 0) return raw;',
          '  const delta = raw * jr * (Math.random() * 2 - 1);',
          '  return Math.min(safeMax, Math.max(0, Math.round(raw + delta)));',
          '}',
        ].join('\n') + '\n',
        'src/scheduler/window.js': [
          'export class SlidingWindowLimiter {',
          '  constructor({ limit = 3, windowMs = 1000 } = {}) { this.limit = limit; this.windowMs = windowMs; this.hits = []; }',
          '  allow(nowMs) {',
          '    this.hits = this.hits.filter((t) => nowMs - t < this.windowMs);',
          '    if (this.hits.length >= this.limit) return false;',
          '    this.hits.push(nowMs);',
          '    return true;',
          '  }',
          '}',
        ].join('\n') + '\n',
      };

    case 'ar-07-multi-stage-dev':
      return {
        'src/parser.js': [
          'export function parseManifest(text) {',
          '  const entries = {};',
          '  const errors = [];',
          '  const seen = new Set();',
          '  const lines = String(text ?? "").split(/\\r?\\n/);',
          '  for (let idx = 0; idx < lines.length; idx++) {',
          '    const line = lines[idx].trim();',
          '    if (!line || line.startsWith("#")) continue;',
          '    const eq = line.indexOf("=");',
          '    if (eq <= 0) {',
          '      errors.push({ line: idx + 1, code: "SYNTAX_ERROR", message: "Expected KEY = VALUE" });',
          '      continue;',
          '    }',
          '    const key = line.slice(0, eq).trim();',
          '    let val = line.slice(eq + 1).trim();',
          '    if ((val.startsWith(\'"\') && val.endsWith(\'"\')) || (val.startsWith("\'") && val.endsWith("\'"))) val = val.slice(1, -1);',
          '    if (seen.has(key)) {',
          '      errors.push({ line: idx + 1, code: "DUPLICATE_KEY", key, message: `Duplicate key: ${key}` });',
          '      continue;',
          '    }',
          '    seen.add(key);',
          '    entries[key] = val;',
          '  }',
          '  return { entries, errors };',
          '}',
        ].join('\n') + '\n',
        'src/validator.js': [
          'const ALLOWED_KEYS = new Set(["SERVICE_NAME", "PORT", "MODE"]);',
          'const MODES = new Set(["dev", "staging", "prod"]);',
          'export function validateManifest(parsed, { strict = false } = {}) {',
          '  const entries = parsed?.entries ?? {};',
          '  const errors = [...(parsed?.errors ?? [])];',
          '  if (!String(entries.SERVICE_NAME ?? "").trim()) errors.push({ code: "MISSING_REQUIRED", key: "SERVICE_NAME" });',
          '  const port = Number(entries.PORT);',
          '  if (!Number.isInteger(port) || port < 1 || port > 65535) errors.push({ code: "INVALID_PORT", key: "PORT" });',
          '  if (!MODES.has(String(entries.MODE ?? ""))) errors.push({ code: "INVALID_MODE", key: "MODE" });',
          '  if (strict) {',
          '    for (const k of Object.keys(entries)) {',
          '      if (!ALLOWED_KEYS.has(k)) errors.push({ code: "UNKNOWN_KEY", key: k });',
          '    }',
          '  }',
          '  return { valid: errors.length === 0, entries, errors };',
          '}',
        ].join('\n') + '\n',
        'bin/policy-cli.js': [
          '#!/usr/bin/env node',
          "import { readFileSync } from 'node:fs';",
          "import { parseManifest } from '../src/parser.js';",
          "import { validateManifest } from '../src/validator.js';",
          'const args = process.argv.slice(2);',
          'let file = null;',
          'let format = "text";',
          'let strict = false;',
          'for (let i = 0; i < args.length; i++) {',
          '  if (args[i] === "--file") file = args[++i];',
          '  else if (args[i] === "--format") format = args[++i] || "text";',
          '  else if (args[i] === "--strict") strict = true;',
          '}',
          'if (!file) { process.stderr.write("--file is required\\n"); process.exit(1); }',
          'let content;',
          'try { content = readFileSync(file, "utf8"); } catch (err) { process.stderr.write(err.message + "\\n"); process.exit(1); }',
          'const result = validateManifest(parseManifest(content), { strict });',
          'if (format === "json") process.stdout.write(JSON.stringify(result) + "\\n");',
          'else process.stdout.write((result.valid ? "VALID" : "INVALID") + "\\n");',
          'process.exit(result.valid ? 0 : 2);',
        ].join('\n') + '\n',
        'test/cli-pipeline.test.js': [
          "import test from 'node:test';",
          "import assert from 'node:assert/strict';",
          "import { parseManifest } from '../src/parser.js';",
          "import { validateManifest } from '../src/validator.js';",
          "test('parser and validator work end-to-end', () => {",
          '  const p = parseManifest("SERVICE_NAME = svc\\nPORT = 3000\\nMODE = dev\\n");',
          '  assert.equal(validateManifest(p, { strict: true }).valid, true);',
          '});',
        ].join('\n') + '\n',
      };

    case 'ar-08-mid-task-recovery':
      return {
        'src/workflow/stage-store.js': [
          "import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';",
          "import { join } from 'node:path';",
          'export async function loadCheckpoint(workDir) {',
          '  try {',
          '    return JSON.parse(await readFile(join(workDir, "checkpoint.json"), "utf8"));',
          '  } catch (err) {',
          '    if (err?.code === "ENOENT") return null;',
          '    throw err;',
          '  }',
          '}',
          'export async function saveCheckpointAtomic(workDir, state) {',
          '  await mkdir(workDir, { recursive: true });',
          '  const tmp = join(workDir, `.checkpoint.${process.pid}.${Date.now()}.tmp`);',
          '  await writeFile(tmp, JSON.stringify(state, null, 2) + "\\n", "utf8");',
          '  await rename(tmp, join(workDir, "checkpoint.json"));',
          '}',
        ].join('\n') + '\n',
        'src/workflow/checkpoint-runner.js': [
          "import { createHash } from 'node:crypto';",
          "import { loadCheckpoint, saveCheckpointAtomic } from './stage-store.js';",
          'export async function executeWithCheckpoint(workDir, stages, { crashAfterStage = null, fenceToken = null } = {}) {',
          '  const state = (await loadCheckpoint(workDir)) ?? { completedStages: [], fenceToken, stageDigests: {} };',
          '  if (fenceToken && state.fenceToken && state.fenceToken !== fenceToken) throw new Error("STALE_FENCE_ERROR");',
          '  state.fenceToken = fenceToken ?? state.fenceToken ?? null;',
          '  for (const stage of stages) {',
          '    if (state.completedStages.includes(stage.id)) continue;',
          '    const out = await stage.run();',
          '    state.completedStages.push(stage.id);',
          '    state.stageDigests[stage.id] = createHash("sha256").update(JSON.stringify(out ?? null)).digest("hex");',
          '    await saveCheckpointAtomic(workDir, state);',
          '    if (crashAfterStage && stage.id === crashAfterStage) throw new Error("CRASH_INTERRUPTED");',
          '  }',
          '  return state;',
          '}',
          'export async function resumeExecution(workDir, stages, { fenceToken = null } = {}) {',
          '  return executeWithCheckpoint(workDir, stages, { fenceToken });',
          '}',
        ].join('\n') + '\n',
        'test/recovery.test.js': [
          "import test from 'node:test';",
          "import assert from 'node:assert/strict';",
          "import { mkdtemp, rm } from 'node:fs/promises';",
          "import { tmpdir } from 'node:os';",
          "import { join } from 'node:path';",
          "import { executeWithCheckpoint, resumeExecution } from '../src/workflow/checkpoint-runner.js';",
          "test('resumes idempotently after mid-execution crash', async () => {",
          '  const dir = await mkdtemp(join(tmpdir(), "ar08-test-"));',
          '  const ran = [];',
          '  const stages = [{ id: "a", run: () => ran.push("a") }, { id: "b", run: () => ran.push("b") }];',
          '  try {',
          '    await assert.rejects(() => executeWithCheckpoint(dir, stages, { crashAfterStage: "a", fenceToken: "f1" }), /CRASH_INTERRUPTED/);',
          '    await resumeExecution(dir, stages, { fenceToken: "f1" });',
          '    await resumeExecution(dir, stages, { fenceToken: "f1" });',
          '    assert.deepEqual(ran, ["a", "b"]);',
          '  } finally { await rm(dir, { recursive: true, force: true }); }',
          '});',
        ].join('\n') + '\n',
      };

    case 'ar-09-multi-agent-collab': {
      const tokSrc = [
        'export function tokenize(expr) {',
        '  const src = String(expr ?? "");',
        '  const tokens = [];',
        '  let i = 0;',
        '  while (i < src.length) {',
        '    if (/\\s/.test(src[i])) { i++; continue; }',
        '    if (/[0-9.]/.test(src[i])) {',
        '      let num = "";',
        '      while (i < src.length && /[0-9.]/.test(src[i])) num += src[i++];',
        '      tokens.push({ type: "number", value: Number(num) });',
        '      continue;',
        '    }',
        '    if ("+-*/()".includes(src[i])) { tokens.push({ type: "op", value: src[i++] }); continue; }',
        '    throw new SyntaxError("Unexpected character: " + src[i]);',
        '  }',
        '  return tokens;',
        '}',
      ].join('\n') + '\n';
      const evalSrc = [
        'export function evaluateTokens(tokens) {',
        '  let pos = 0;',
        '  const peek = () => tokens[pos];',
        '  const next = () => tokens[pos++];',
        '  function parseExpr() {',
        '    let left = parseTerm();',
        '    while (peek()?.value === "+" || peek()?.value === "-") {',
        '      const op = next().value;',
        '      const right = parseTerm();',
        '      left = op === "+" ? left + right : left - right;',
        '    }',
        '    return left;',
        '  }',
        '  function parseTerm() {',
        '    let left = parseFactor();',
        '    while (peek()?.value === "*" || peek()?.value === "/") {',
        '      const op = next().value;',
        '      const right = parseFactor();',
        '      if (op === "/") { if (right === 0) throw new RangeError("Division by zero"); left /= right; }',
        '      else left *= right;',
        '    }',
        '    return left;',
        '  }',
        '  function parseFactor() {',
        '    const tok = next();',
        '    if (!tok) throw new SyntaxError("Unexpected EOF");',
        '    if (tok.type === "number") return tok.value;',
        '    if (tok.value === "(") {',
        '      const val = parseExpr();',
        '      if (next()?.value !== ")") throw new SyntaxError("Expected )");',
        '      return val;',
        '    }',
        '    throw new SyntaxError("Unexpected token");',
        '  }',
        '  return parseExpr();',
        '}',
      ].join('\n') + '\n';
      const idxSrc = [
        "import { tokenize } from './modules/tokenizer.js';",
        "import { evaluateTokens } from './modules/evaluator.js';",
        'export function evaluate(expr) { return evaluateTokens(tokenize(expr)); }',
      ].join('\n') + '\n';
      const sortedArtifacts = [
        { path: 'src/index.js', sha256: sha256Text(idxSrc) },
        { path: 'src/modules/evaluator.js', sha256: sha256Text(evalSrc) },
        { path: 'src/modules/tokenizer.js', sha256: sha256Text(tokSrc) },
      ];
      const digest = sha256Text(JSON.stringify(sortedArtifacts));
      return {
        'src/modules/tokenizer.js': tokSrc,
        'src/modules/evaluator.js': evalSrc,
        'src/index.js': idxSrc,
        'handoff/artifacts.json': JSON.stringify({ schemaVersion: '1.0.0', artifacts: sortedArtifacts }, null, 2) + '\n',
        'handoff/digest.txt': digest + '\n',
        'handoff/reviewer-verdict.json': JSON.stringify({
          schemaVersion: '1.0.0',
          verdict: 'pass',
          summary: 'Verified tokenizer, evaluator, and SHA-256 handoff digests.',
          evidenceDigest: digest,
          checkedArtifacts: sortedArtifacts.map((a) => a.path),
          findings: [],
          readOnlyVerified: true,
        }, null, 2) + '\n',
        'test/collab.test.js': [
          "import test from 'node:test';",
          "import assert from 'node:assert/strict';",
          "import { evaluate } from '../src/index.js';",
          "test('evaluates arithmetic expression cleanly', () => {",
          '  assert.equal(evaluate("2 + 3 * 4"), 14);',
          '});',
        ].join('\n') + '\n',
      };
    }

    case 'ar-10-long-horizon-delivery':
      return {
        'src/core/ledger.js': [
          'export function legacySummary(entries) {',
          '  return entries.reduce((acc, e) => acc + Number(e.amountCents || 0), 0);',
          '}',
          'export function parseEntries(text) {',
          '  return String(text ?? "")',
          '    .split(/\\r?\\n/)',
          '    .map((l) => l.trim())',
          '    .filter(Boolean)',
          '    .map((line) => {',
          '      const [account, amount] = line.split(",");',
          '      return { account: account.trim(), amountCents: Number(amount.trim()) };',
          '    });',
          '}',
        ].join('\n') + '\n',
        'src/core/reconcile.js': [
          'function sumByAccount(entries) {',
          '  const map = new Map();',
          '  for (const e of entries) {',
          '    map.set(e.account, (map.get(e.account) ?? 0) + Number(e.amountCents || 0));',
          '  }',
          '  return map;',
          '}',
          'export function reconcileLedgers(leftEntries = [], rightEntries = []) {',
          '  const leftMap = sumByAccount(leftEntries);',
          '  const rightMap = sumByAccount(rightEntries);',
          '  const names = [...new Set([...leftMap.keys(), ...rightMap.keys()])].sort((a, b) => a.localeCompare(b));',
          '  const accounts = names.map((account) => {',
          '    const leftCents = leftMap.get(account) ?? 0;',
          '    const rightCents = rightMap.get(account) ?? 0;',
          '    return { account, leftCents, rightCents, deltaCents: leftCents - rightCents };',
          '  });',
          '  const discrepancies = accounts.filter((a) => a.deltaCents !== 0);',
          '  return { accounts, discrepancies };',
          '}',
          'export function formatAuditReport(result) { return JSON.stringify(result, null, 2); }',
        ].join('\n') + '\n',
        'src/cli/audit.js': [
          '#!/usr/bin/env node',
          "import { readFileSync } from 'node:fs';",
          "import { reconcileLedgers, formatAuditReport } from '../core/reconcile.js';",
          'const args = process.argv.slice(2);',
          'const idx = args.indexOf("--input");',
          'if (idx < 0 || !args[idx + 1]) { process.stderr.write("--input required\\n"); process.exit(1); }',
          'const raw = JSON.parse(readFileSync(args[idx + 1], "utf8"));',
          'process.stdout.write(formatAuditReport(reconcileLedgers(raw.left, raw.right)) + "\\n");',
        ].join('\n') + '\n',
        'REPORTS/delivery-audit.json': JSON.stringify({
          schemaVersion: '1.0.0',
          constraints: {
            C1: { verified: true, note: 'zero runtime dependencies' },
            C2: { verified: true, note: 'legacySummary preserved' },
            C3: { verified: true, note: 'lexicographical sorting enforced' },
            C4: { verified: true, note: 'core modules pure' },
            C5: { verified: true, note: 'audit report emitted' },
          },
        }, null, 2) + '\n',
        'test/reconcile.test.js': [
          "import test from 'node:test';",
          "import assert from 'node:assert/strict';",
          "import { parseEntries } from '../src/core/ledger.js';",
          "import { reconcileLedgers } from '../src/core/reconcile.js';",
          "test('reconciles sorted accounts and identifies discrepancies', () => {",
          '  const res = reconcileLedgers(parseEntries("b,10\\na,5"), parseEntries("a,5\\nb,20"));',
          '  assert.deepEqual(res.accounts.map((x) => x.account), ["a", "b"]);',
          '  assert.deepEqual(res.discrepancies.map((x) => x.account), ["b"]);',
          '});',
        ].join('\n') + '\n',
      };

    default:
      throw new Error(`Unknown autonomous reasoning taskId: ${taskId}`);
  }
}

export function applyWorkspaceFiles(workspaceRoot, fileMap) {
  for (const [rel, content] of Object.entries(fileMap ?? {})) {
    const abs = join(workspaceRoot, rel);
    if (!isPathInsideRoot(workspaceRoot, abs, { allowEqual: false })) {
      throw new Error(`Refusing to write outside workspace: ${rel}`);
    }
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, String(content), 'utf8');
  }
}

export function buildAutonomousReasoningEvidenceOutput(task, changedFiles = null, overrides = {}) {
  const actualChanged = changedFiles ?? task.metadata.acceptanceCriteria.requiredChangedFiles;
  const cmdStr = task.metadata.acceptanceCriteria.testCommand.join(' ');
  return {
    output: {
      schemaVersion: EVIDENCE_MANIFEST_SCHEMA_VERSION,
      taskId: task.id,
      attemptId: 'attempt-1',
      planVersion: 1,
      summary: `Completed ${task.id} with verified acceptance checks.`,
      changedFiles: actualChanged,
      testCommand: cmdStr,
      testExitCode: 0,
      testEvidence: [{ command: cmdStr, exitCode: 0 }],
      artifactRefs: [],
      ...overrides,
    },
  };
}
