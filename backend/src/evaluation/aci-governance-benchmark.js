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
import { canonicalJson, computeSha256Hex, computeWorkspaceArtifactDigest } from './hidden-acceptance.js';
import { DEFAULT_DEPENDENCY_POLICY, validatePackageDependencies } from './dependency-policy.js';
import { enforceDeterministicHardVeto } from './judge.js';
import { estimateTaskBudget } from '../planning/budget-estimator.js';
import { estimateTokens } from '../context.js';
import {
  FAILURE_ATTRIBUTIONS,
  applyWorkspaceFiles,
  classifyAutonomousReasoningAttribution,
} from './autonomous-reasoning-benchmark.js';

export const ACI_GOVERNANCE_BENCHMARK_ID = 'agent-us-aci-governance-2.4-s4';
export const VERSION = '1.0.0';

export const ACI_GOVERNANCE_TASK_IDS = Object.freeze([
  'aci-01-auth-tenant-boundary',
  'aci-02-persistence-wal-ledger',
  'aci-03-contract-pipeline-refactor',
  'aci-04-long-horizon-security-audit',
]);

export const ACI_25_EXTRA_TASK_IDS = Object.freeze([
  'aci-05-multi-module-patch-refactor',
  'aci-06-swarm-contract-integration',
]);

export const ACI_GOVERNANCE_25_TASK_IDS = Object.freeze([
  ...ACI_GOVERNANCE_TASK_IDS,
  ...ACI_25_EXTRA_TASK_IDS,
]);

export const ACI_26_EXTRA_TASK_IDS = Object.freeze([
  'aci-07-cross-module-evolution',
]);

export const ACI_GOVERNANCE_26_TASK_IDS = Object.freeze([
  ...ACI_GOVERNANCE_25_TASK_IDS,
  ...ACI_26_EXTRA_TASK_IDS,
]);

export const TRAJECTORY_EVICTION_V26_DTOC_POLICY = 'trajectory_eviction_v26';

export const ACI_25_PROFILE_ALIASES = Object.freeze(new Set(['full_aci', 'aci_25']));
export const ACI_26_PROFILE_ALIASES = Object.freeze(new Set(['full_aci', 'aci_25', 'aci_26']));

export function normalizeAciProfileName(profile) {
  const clean = String(profile ?? '').trim();
  if (!clean) return 'full_aci';
  if (clean === 'aci_25') return 'aci_25';
  if (clean === 'aci_26') return 'aci_26';
  return clean;
}

export function isFullAciProfile(profile) {
  return ACI_26_PROFILE_ALIASES.has(String(profile ?? '').trim());
}

export const ACI_ARM_PROFILES = Object.freeze({
  A: Object.freeze({
    arm: 'A',
    aciProfile: 'raw_full',
    label: 'Arm A (Raw Full)',
    description: 'Raw full-file context injection with admission, supervisor, and DTOC disabled',
  }),
  B: Object.freeze({
    arm: 'B',
    aciProfile: 'deterministic_progressive',
    label: 'Arm B (Deterministic Progressive)',
    description: 'Pre-injection heuristic admission without Supervisor or adaptive DTOC',
  }),
  C: Object.freeze({
    arm: 'C',
    aciProfile: 'retrieval_supervisor',
    label: 'Arm C (Retrieval + Supervisor)',
    description: 'Pre-injection admission plus batched read-only ContextSupervisor without DTOC',
  }),
  D: Object.freeze({
    arm: 'D',
    aciProfile: 'full_aci',
    label: 'Arm D (Full ACI + DTOC + Recovery)',
    description: 'Pre-injection admission, read-only Supervisor, adaptive single-step DTOC, and SHA-256 lossless recovery',
  }),
});

export { applyWorkspaceFiles, FAILURE_ATTRIBUTIONS };

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
  const targets = [
    ...new Set([...protectedFiles, ...Object.keys(expectedHashes)].map(normalizeEvidencePath).filter(Boolean)),
  ];
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
  if (extraChecks && extraChecks.constraintsPreserved === false) return 'constraint_dropped';
  if (!hiddenResult?.passed || !hiddenResult?.verified) return 'hidden_acceptance_failed';
  if (!implementationPassed || !validation.checks.changedFiles) return 'implementation_failed';
  if (!testsPassed || !validation.checks.testReceiptVerified) return 'test_failed';
  if (validation.status === EVIDENCE_STATUSES.INCOMPLETE) return 'evidence_incomplete';
  if (!validation.checks.independentVerdict) return 'independent_verdict_failed';
  return 'evidence_invalid';
}

function makeAciGovernanceJudge({
  requiredSourceFiles,
  hiddenAcceptanceScript,
  protectedReadOnlyFiles = [],
  rootCauseFiles = null,
  extraCheck = null,
}) {
  return async function aciGovernanceJudge({ task, output, context = {} }) {
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
      checkFilesUnmodifiedSince(workspaceRoot, pinnedCommit, protectedReadOnlyFiles, protectedHashes),
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
    const rootCauseFilesTouched =
      Array.isArray(rootCauseFiles) && rootCauseFiles.length > 0
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
      baselineTestsUntampered && baselineTestExitCode === 0 && actualTestExitCode === 0;
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
      extraChecks,
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
        ? 'aci_governance_acceptance_complete'
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

// ---------------------------------------------------------------------------
// Realistic Domain-Confusable Decoy Generators (>= 3 KB each, unreferenced)
// ---------------------------------------------------------------------------

function buildLegacyJsDecoy({ moduleLabel, domainKeywords, exportsList, rows = 42 }) {
  const lines = [
    `// ARCHIVED / UNREFERENCED ${moduleLabel}`,
    `// Keywords: ${domainKeywords.join(', ')}`,
    '// Retained strictly for historical v0/v1 reference; NOT imported by active v2 runtime.',
    `export const LEGACY_MODULE_TAG = ${JSON.stringify(moduleLabel)};`,
    'export const LEGACY_KEYWORD_TABLE = Object.freeze([',
  ];
  for (let i = 0; i < rows; i++) {
    const kw = domainKeywords[i % domainKeywords.length];
    lines.push(
      `  { seq: ${i + 1}, domain: ${JSON.stringify(kw)}, mode: "v1-compat", allowFallback: true, weight: ${(i % 7) + 1}, note: "legacy_${kw}_rule_${i + 1}_deprecated" },`,
    );
  }
  lines.push(']);');
  for (const fnName of exportsList) {
    lines.push(
      `export function ${fnName}(input = {}) {`,
      `  const tag = LEGACY_MODULE_TAG;`,
      `  const entries = LEGACY_KEYWORD_TABLE.filter((row) => row.weight > 0);`,
      `  return { legacy: true, tag, handled: entries.length, inputKeys: Object.keys(input || {}) };`,
      `}`,
    );
  }
  return lines.join('\n') + '\n';
}

function buildChangelogDecoy({ title, keywords, releases = 24 }) {
  const lines = [`# ${title} — Historical Changelog`, ''];
  for (let i = releases; i >= 1; i--) {
    const kwA = keywords[i % keywords.length];
    const kwB = keywords[(i + 2) % keywords.length];
    lines.push(
      `## v0.${i}.0 (${2023 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}-15)`,
      `- Adjusted ${kwA} pipeline handling for legacy compatibility flags and ${kwB} serialization.`,
      `- Added diagnostic telemetry hooks around ${kwA}/${kwB} transitions and archival dumps.`,
      `- Deprecated old v1 ${kwA} shim options (superseded by current SPEC/CONTRACT invariants).`,
      '',
    );
  }
  return lines.join('\n');
}

function buildCsvDecoy({ headerCols, keywords, rows = 85 }) {
  const lines = [headerCols.join(',')];
  for (let i = 1; i <= rows; i++) {
    const kwA = keywords[i % keywords.length];
    const kwB = keywords[(i + 1) % keywords.length];
    lines.push(
      `${i},2025-02-${String((i % 28) + 1).padStart(2, '0')}T10:${String(i % 60).padStart(2, '0')}:00Z,${kwA},${kwB},tenant-${(i % 5) + 1},sha256-${String(i).padStart(8, '0')}abcdef,ok,legacy_sample_trace_${i}`,
    );
  }
  return lines.join('\n') + '\n';
}

function buildJsonFixtureDecoy({ title, keywords, count = 48 }) {
  const records = [];
  for (let i = 1; i <= count; i++) {
    const kw = keywords[i % keywords.length];
    records.push({
      id: `sample-${i}`,
      category: kw,
      legacyProfile: `v1-${kw}`,
      enabled: i % 2 === 0,
      tokens: keywords.slice(0, 4),
      metadata: {
        seq: i,
        checksum: sha256Text(`${title}:${i}:${kw}`).slice(0, 16),
        notes: `Synthetic fixture record ${i} for ${kw} validation archives`,
      },
    });
  }
  return JSON.stringify({ schema: 'v1-fixture', title, records }, null, 2) + '\n';
}

function buildOpenApiDecoy({ serviceName, keywords, endpoints = 16 }) {
  const paths = {};
  for (let i = 1; i <= endpoints; i++) {
    const kw = keywords[i % keywords.length];
    paths[`/v1/${kw}/action-${i}`] = {
      post: {
        operationId: `legacy_${kw}_${i}`,
        summary: `Deprecated V1 ${kw} operation #${i}`,
        parameters: [
          { name: 'x-tenant-id', in: 'header', required: false, schema: { type: 'string' } },
          { name: 'authorization', in: 'header', required: true, schema: { type: 'string' } },
        ],
        responses: {
          200: { description: `Legacy ${kw} response payload` },
          403: { description: `Legacy ${kw} forbidden error` },
        },
      },
    };
  }
  return (
    JSON.stringify(
      {
        openapi: '3.0.3',
        info: { title: `${serviceName} Legacy V1 API`, version: '1.0.0-deprecated' },
        paths,
      },
      null,
      2,
    ) + '\n'
  );
}

function buildMarkdownArchiveDecoy({ title, keywords, sections = 18 }) {
  const lines = [`# ${title} (Archived V0/V1 Reference)`, ''];
  for (let i = 1; i <= sections; i++) {
    const kw = keywords[i % keywords.length];
    lines.push(
      `## Section ${i}: Historical ${kw} Notes`,
      `During early V0 prototypes, ${kw} checks used permissive fallback tables and unverified snapshots.`,
      `Do not copy v0 settings into production; refer to active modules under \`src/\` for authoritative behavior.`,
      `Reference token: \`legacy_${kw}_policy_${i}\` | checksum: \`${sha256Text(`${title}:${i}`).slice(0, 24)}\`.`,
      '',
    );
  }
  return lines.join('\n');
}

function buildSqlDecoy({ tableName, keywords, rows = 80 }) {
  const lines = [
    `-- Historical SQL migration dump for ${tableName}`,
    `CREATE TABLE IF NOT EXISTS ${tableName} (id INTEGER PRIMARY KEY, seq INTEGER, domain TEXT, payload TEXT, crc TEXT);`,
  ];
  for (let i = 1; i <= rows; i++) {
    const kw = keywords[i % keywords.length];
    lines.push(
      `INSERT INTO ${tableName} (id, seq, domain, payload, crc) VALUES (${i}, ${i * 10}, '${kw}', '{"legacy":true,"key":"${kw}_${i}"}', '${sha256Text(`${kw}:${i}`).slice(0, 8)}');`,
    );
  }
  return lines.join('\n') + '\n';
}

function buildHtmlTemplateDecoy({ title, keywords, blocks = 28 }) {
  const lines = [
    '<!DOCTYPE html>',
    '<html lang="en">',
    `<head><meta charset="utf-8"><title>${title}</title>`,
    '<style>body{font-family:monospace;margin:24px;} .card{border:1px solid #ccc;padding:8px;margin:6px 0;}</style>',
    '</head>',
    `<body><h1>${title} Template Placeholder</h1>`,
  ];
  for (let i = 1; i <= blocks; i++) {
    const kw = keywords[i % keywords.length];
    lines.push(
      `<div class="card" data-kind="${kw}"><span>Row ${i}: {{${kw}_digest}}</span><code>status={{status_${i}}}</code></div>`,
    );
  }
  lines.push('</body></html>');
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Shared Active Module Snippets for Task Fixtures & Reference Fixes
// ---------------------------------------------------------------------------

const ACI_01_RUNTIME_OPTIONS = (() => {
  const lines = [
    '// Active V2 Runtime Options & Security Invariants',
    '// NOTE: Multi-section configuration module. Read SECURITY_INVARIANTS at bottom carefully.',
    'export const DEPLOYMENT_PROFILES = Object.freeze({',
  ];
  for (let i = 1; i <= 26; i++) {
    lines.push(
      `  tier_${i}: Object.freeze({ tier: ${i}, maxRequestsPerMinute: ${i * 120}, auditSampling: ${i % 2 === 0 ? 1 : 0.25}, region: "us-east-${(i % 3) + 1}" }),`,
    );
  }
  lines.push(
    '});',
    '',
    'export const LEGACY_COMPAT_WARNINGS = Object.freeze([',
    '  "v1-auth-compat.js is deprecated and must never be imported by v2 auth-routes.",',
    '  "Wildcard role (*) and implicit default-tenant fallbacks are strictly disabled in v2.",',
    '  "Cross-tenant header overrides are rejected unconditionally in strictTenantIsolation mode.",',
    ']);',
    '',
    '// Critical Security Invariants enforced by tenant-context.js & rbac-guard.js:',
    'export const SECURITY_INVARIANTS = Object.freeze({',
    '  strictTenantIsolation: true,',
    '  allowWildcardRole: false,',
    '  defaultEffect: "deny",',
    '  requireExplicitPermissionMatch: true,',
    '  tenantRoleBindingRequired: true,',
    '  suspendedTenants: Object.freeze(["tenant-suspended", "tenant-revoked"]),',
    '});',
    '',
    'export function getRuntimeOptions(overrides = {}) {',
    '  return Object.freeze({',
    '    tokenSecret: "agent-us-v2-hmac-secret",',
    '    ...SECURITY_INVARIANTS,',
    '    ...overrides,',
    '  });',
    '}',
  );
  return lines.join('\n') + '\n';
})();

const ACI_01_SPEC = [
  '# V2 Auth & Tenant Isolation Specification',
  '',
  '## Pipeline Architecture',
  '- Entry route handler `src/api/auth-routes.js` chains:',
  '  1. `verifyBearerToken` (`src/auth/token-verifier.js`)',
  '  2. `resolveTenantContext` (`src/middleware/tenant-context.js`)',
  '  3. `authorizeRequest` (`src/auth/rbac-guard.js`)',
  '- Authoritative security configuration lives in `src/core/runtime-options.js` (`SECURITY_INVARIANTS` / `getRuntimeOptions`).',
  '',
  '## Tenant Isolation Rules (`src/middleware/tenant-context.js`)',
  '1. `claims.tenantId` is mandatory; missing/empty `claims.tenantId` MUST fail closed (`status: 403, code: "TENANT_CONTEXT_MISSING"`). Never fall back to `"default-tenant"`.',
  '2. When `x-tenant-id` header is supplied (case-insensitive), reject array values, whitespace/comma-joined values (e.g. `tenant-a,tenant-b`), or prototype keys (`__proto__`, `constructor`, `prototype`), and if `headerTenant !== claims.tenantId` under `strictTenantIsolation !== false`, fail closed (`status: 403, code: "TENANT_MISMATCH"`).',
  '3. Reject tenants listed in `runtimeOptions.suspendedTenants` (`status: 403, code: "TENANT_SUSPENDED"`).',
  '',
  '## RBAC Default-Deny Rules (`src/auth/rbac-guard.js`)',
  '1. Default-deny: missing `claims`, unverified `tenantContext`, mismatched `claims.tenantId !== tenantContext.tenantId`, unknown roles, or unknown actions MUST return `{ allowed: false, status: 403, code: "RBAC_DENIED" }`.',
  '2. Wildcard role `"*"` (or `"admin:*"`) MUST be rejected when `allowWildcardRole === false` (`code: "RBAC_WILDCARD_FORBIDDEN"`).',
  '3. When `claims.tenantRoles` is present, resolve roles strictly from own-property `claims.tenantRoles[tenantContext.tenantId]` (never inherit roles assigned to other tenants!).',
  '4. Never allow prefix shortcuts (such as `action.startsWith("read:")`). Match exact permission strings from `ROLE_PERMISSIONS`.',
].join('\n') + '\n';

const ACI_02_SPEC = [
  '# Persistence WAL & Checkpoint Reconciliation Specification',
  '',
  '## WAL Frame Format (`src/persistence/wal-store.js`)',
  '- Each line in the WAL file is a JSON object: `{ seq, idempotencyKey, account, deltaCents, crc }`.',
  '- `crc` MUST be computed with `computeWalRecordCrc(record)` from `src/persistence/crc32.js`.',
  '- `appendWalRecord(walPath, entry)` validates `Number.isInteger(seq) && seq > 0`, non-empty `idempotencyKey`, non-empty `account`, and finite integer `deltaCents`, then appends a line with CRC.',
  '- `verifyWalChecksum(record)` returns `true` ONLY when `record.crc` matches `computeWalRecordCrc(record)`.',
  '- `replayWal(walPath, { allowCorruptTail = true } = {})` reads records:',
  '  - If the **final non-empty line** is truncated JSON or fails `verifyWalChecksum`, and `allowCorruptTail` is true, stop cleanly at the prior record and return `{ records, truncatedTail: true, corruptTailCount: 1 }`.',
  '  - If any **non-final (mid-stream)** line is malformed or fails `verifyWalChecksum`, or `allowCorruptTail === false`, throw `new Error("WAL_CRC_MISMATCH: ...")`.',
  '  - Returned `records` MUST be sorted **numerically** ascending by `Number(a.seq) - Number(b.seq)` (never lexicographically!).',
  '',
  '## Checkpoint Reconciliation (`src/persistence/checkpoint-reconciler.js` + `src/api/ledger-contract.js`)',
  '- `reconcileCheckpoint(checkpointState, walRecords)` starts from `{ lastAppliedSeq, appliedKeys, balances }`, sorts `walRecords` numerically ascending by `seq`, skips any record where `seq <= lastAppliedSeq` or `appliedKeys` already contains `idempotencyKey`, applies balance delta via `applyLedgerEntry`, and computes `digest = computeLedgerDigest(...)`.',
  '- `compactWal(walPath, checkpointState)` rewrites the WAL keeping only records with valid CRCs whose `seq > lastAppliedSeq` and `!appliedKeys.has(idempotencyKey)`.',
].join('\n') + '\n';

const ACI_02_CONSTRAINTS = [
  '# Persistence Constraints',
  '- **C1**: Zero external npm dependencies in `package.json`.',
  '- **C2**: Preserve all public exports (`appendWalRecord`, `replayWal`, `verifyWalChecksum` in `src/persistence/wal-store.js`; `reconcileCheckpoint`, `compactWal` in `src/persistence/checkpoint-reconciler.js`; `applyLedgerEntry`, `computeLedgerDigest`, `verifyLedgerState` in `src/api/ledger-contract.js`).',
  '- **C3**: Replay MUST order records numerically (`seq: 2` before `seq: 10`) and guarantee idempotency across `seq <= lastAppliedSeq` and duplicate `idempotencyKey` entries.',
  '- **C4**: Truncated or CRC-corrupted trailing final record recovers committed prefix (`truncatedTail: true`), while mid-stream corruption MUST throw `WAL_CRC_MISMATCH`.',
].join('\n') + '\n';

const ACI_02_WAL_STORE_HEADER = (() => {
  const lines = [
    "import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';",
    "import { computeWalRecordCrc } from './crc32.js';",
    '',
    '// WAL Frame Specification & Diagnostic Lookup Table (lines 1-65)',
    'export const WAL_FRAME_SCHEMA = Object.freeze({',
    '  version: 2,',
    '  fields: Object.freeze(["seq", "idempotencyKey", "account", "deltaCents", "crc"]),',
    '  crcAlgorithm: "ieee-crc32-hex",',
  ];
  for (let i = 1; i <= 54; i++) {
    lines.push(`  opcode_${i}: "WAL_OP_${String(i).padStart(2, '0')}_RESERVED_FRAME_CODE",`);
  }
  lines.push('});', '');
  return lines.join('\n');
})();

const ACI_03_CONTRACT_JSON = JSON.stringify(
  {
    schemaVersion: '1.0.0',
    contractId: 'aci-03-config-pipeline',
    stages: ['loader', 'normalizer', 'precedence-resolver', 'evaluator'],
    precedence: ['cli', 'env', 'workspace', 'defaults'],
    precedenceOrderRule: 'highest-to-lowest: cli overrides env overrides workspace overrides defaults',
    normalization: {
      keyStyle: 'snake_case',
      lowercase: true,
      separatorPattern: '[\\s-]+',
      replacement: '_',
      stripUndefinedAndNull: true,
      preserveFalsyValues: [0, false, ''],
      blockedKeys: ['__proto__', 'constructor', 'prototype'],
      recursivePlainObjects: true,
    },
    requiredOutputKeys: ['effectiveConfig', 'provenance', 'evaluatedRules', 'checksum'],
    checksumAlgorithm: 'sha256(canonicalJson({ effectiveConfig, provenance, evaluatedRules }))',
    rules: {
      max_concurrency: { type: 'integer', min: 1, max: 128, default: 8, note: 'Bounded parallel worker pool concurrency ceiling' },
      timeout_ms: { type: 'integer', min: 100, max: 300000, default: 5000, note: 'Per-stage execution timeout in milliseconds' },
      strict_mode: { type: 'boolean', default: true, note: 'Reject unrecognized schema assertions when enabled' },
      retry_limit: { type: 'integer', min: 0, max: 10, default: 2, note: 'Maximum idempotent retry count (0 allowed as falsy override)' },
      audit_level: { enum: ['off', 'basic', 'strict'], default: 'basic', note: 'Audit emission granularity across evaluated configs' },
    },
    stageContracts: Array.from({ length: 14 }, (_, idx) => ({
      stageIndex: idx + 1,
      code: `PIPE_INVARIANT_${String(idx + 1).padStart(2, '0')}`,
      enforced: true,
      description: `Pipeline contract invariant ${idx + 1}: preserve canonical snake_case normalization, strict precedence cli > env > workspace > defaults, and deterministic SHA-256 checksum.`,
    })),
  },
  null,
  2,
) + '\n';

const ACI_04_SPEC = [
  '# Security Policy & Tamper-Evident Audit Digest Contract',
  '',
  '## Stage 1 — Confined Path Guard (`src/security/path-guard.js`)',
  '- `confineAuditPath(rootDir, candidatePath)` MUST reject empty/non-string inputs, NUL bytes (`\\0`, `%00`), URL-encoded traversals (`%2e`, `%2f`, `%5c`, double-encoded `%252e`), drive prefixes (`C:...`), leading `/` or `\\\\`, `..` segments, and symlinks resolving outside `rootDir` (resolving parent prefix via `realpathSync.native || realpathSync` and `lstatSync`).',
  '',
  '## Stage 2 — Strict Policy Engine (`src/security/policy-engine.js`)',
  '- `evaluateAccessPolicy({ actor, role, action, rootDir, targetPath, auditStore })` MUST call `confineAuditPath(rootDir, targetPath)` without swallowing exceptions into allow, MUST default-deny unknown roles or unlisted actions, and MUST append every decision to `auditStore` when provided.',
  '',
  '## Stage 3 — Tamper-Evident Audit Hash Chain (`src/persistence/audit-store.js`)',
  '- `GENESIS_HASH = "0".repeat(64)`.',
  '- Each appended entry computes `entryHash = sha256(canonicalJson({ seq, prevHash, actor, action, resource, allowed, reason }))` where `prevHash` equals the previous entry `entryHash` (or `GENESIS_HASH` for `seq === 1`).',
  '- `verifyAuditChain(entries)` verifies `seq === idx + 1`, `prevHash` continuity, and exact `entryHash` match for every entry.',
  '',
  '## Stage 4 — Audit Export CLI & `AUDIT_REPORT.json` (`src/cli/audit-export.js`)',
  '- CLI flags: `--input <events.json> --root <dir> --out <report.json>` (defaults: `fixtures/baseline-events.json`, `.`, `AUDIT_REPORT.json`).',
  '- Output JSON schema:',
  '  - `schemaVersion`: `"1.0.0"`',
  '  - `chainValid`: `boolean`',
  '  - `eventCount`: `number`',
  '  - `chainHeadHash`: `string`',
  '  - `artifactDigests`: sorted array `{ path, sha256 }` over `["src/cli/audit-export.js", "src/persistence/audit-store.js", "src/security/path-guard.js", "src/security/policy-engine.js"]`',
  '  - `rootDigestSha256`: `sha256(canonicalJson({ artifactDigests, chainHeadHash, chainValid }))`',
  '  - `entries`: audit entry array',
  '- Must generate verified `AUDIT_REPORT.json` in workspace root matching `fixtures/baseline-events.json`.',
].join('\n') + '\n';

const ACI_04_POLICY_ENGINE_HEADER = (() => {
  const lines = [
    "import { confineAuditPath } from './path-guard.js';",
    '',
    'export const ROLE_POLICIES = Object.freeze({',
    '  auditor: Object.freeze(["audit:read", "report:read"]),',
    '  operator: Object.freeze(["audit:read", "report:read", "audit:export"]),',
    '  security_admin: Object.freeze(["audit:read", "report:read", "audit:export", "policy:write"]),',
    '});',
    '',
    'export const AUDIT_SEVERITY_MATRIX = Object.freeze({',
  ];
  for (let i = 1; i <= 28; i++) {
    lines.push(
      `  EVENT_CODE_${String(i).padStart(2, '0')}: Object.freeze({ code: "SEC-${100 + i}", severity: "${i % 3 === 0 ? 'high' : 'medium'}", retainDays: ${90 + i * 5} }),`,
    );
  }
  lines.push('});', '');
  return lines.join('\n');
})();

const ACI_04_BASELINE_EVENTS = JSON.stringify(
  [
    { actor: 'alice', role: 'auditor', action: 'audit:read', targetPath: 'fixtures/baseline-events.json' },
    { actor: 'bob', role: 'operator', action: 'audit:export', targetPath: 'AUDIT_REPORT.json' },
    { actor: 'mallory', role: 'auditor', action: 'policy:write', targetPath: '../etc/passwd' },
  ],
  null,
  2,
) + '\n';

function buildAci04FixedAuditReport(filesMap) {
  const trackedPaths = [
    'src/cli/audit-export.js',
    'src/persistence/audit-store.js',
    'src/security/path-guard.js',
    'src/security/policy-engine.js',
  ].sort();
  const artifactDigests = trackedPaths.map((p) => ({
    path: p,
    sha256: sha256Text(filesMap[p]),
  }));
  const events = JSON.parse(ACI_04_BASELINE_EVENTS);
  const genesis = '0'.repeat(64);
  let prevHash = genesis;
  const entries = events.map((ev, idx) => {
    const seq = idx + 1;
    const isUnsafe = ev.targetPath.includes('..');
    const allowed = !isUnsafe && (ev.role === 'auditor' ? ev.action === 'audit:read' : ev.action === 'audit:export');
    const reason = isUnsafe ? 'PATH_ESCAPE_BLOCKED' : allowed ? 'ALLOWED' : 'POLICY_DENIED';
    const resource = ev.targetPath;
    const entryHash = sha256Text(
      canonicalJson({ seq, prevHash, actor: ev.actor, action: ev.action, resource, allowed, reason }),
    );
    const rec = { seq, prevHash, actor: ev.actor, action: ev.action, resource, allowed, reason, entryHash };
    prevHash = entryHash;
    return rec;
  });
  const chainHeadHash = entries.at(-1)?.entryHash ?? genesis;
  const chainValid = true;
  const rootDigestSha256 = sha256Text(
    canonicalJson({ artifactDigests, chainHeadHash, chainValid }),
  );
  return (
    JSON.stringify(
      {
        schemaVersion: '1.0.0',
        chainValid,
        eventCount: entries.length,
        chainHeadHash,
        artifactDigests,
        rootDigestSha256,
        entries,
      },
      null,
      2,
    ) + '\n'
  );
}

const ACI_05_SPEC = [
  '# Multi-Module Patch Validation & Diagnostic Compression Specification',
  '',
  '## 1. Diagnostic Parser (`src/diagnostics/parser.js`)',
  '- `parseDiagnosticLines(rawText)` strips ANSI escape sequences (`\\x1b\\[[0-9;]*m`), skips blank lines, normalizes Windows `\\\\` paths to POSIX `/`, and parses:',
  '  - TypeScript / compiler style: `src/foo.ts(12,4): error TS2345: Argument type mismatch`',
  '  - Colon-delimited style: `src/foo.js:12:4: warning W101: Unused import` or `src/foo.js:12: SyntaxError: Unexpected token`',
  '  - Fallback unparsed non-empty lines with `{ file: null, line: null, column: null, severity: "info", code: null, message: trimmedLine }`',
  '- Normalize `severity` to one of `"error" | "warning" | "info"` (treat `"fatal"`/`"syntaxerror"`/`"err"` as `"error"`, `"warn"` as `"warning"`).',
  '',
  '## 2. Diagnostic Deduplicator (`src/diagnostics/deduplicator.js`)',
  '- `deduplicateDiagnostics(entries, { maxItems = 50 } = {})` deduplicates by canonical `(normFile, line, code, message)`, keeping `occurrenceCount` and `firstSeenLine` (minimum line).',
  '- Sort deduplicated items by severity priority (`error` < `warning` < `info`), then `file`, then `line`, then `message`.',
  '- Slice to `maxItems` and return `{ items, compression: { totalRaw, uniqueCount, keptCount, truncatedCount } }` (`truncatedCount = Math.max(0, uniqueCount - items.length)`).',
  '',
  '## 3. Atomic Patch Conflict Guard (`src/patch/conflict-guard.js`)',
  '- `validatePatchBatch(hunks, fileContents = {})` verifies ALL hunks BEFORE returning `appliedFiles` (all-or-nothing atomicity!):',
  '  - Reject empty/invalid relative paths, leading `/`, `..` segments, drive letters (`C:`), or `.git` segments (`code: "PATH_CONFINEMENT_ERROR"`).',
  '  - When `hunk.expectedSha256` is supplied, compare against SHA-256 of `fileContents[normPath]` (missing file = `null`); on any mismatch return `{ ok: false, code: "OPTIMISTIC_LOCK_CONFLICT", conflicts: [...], appliedFiles: {} }`.',
  '  - Compute `{ path, additions, deletions, sha256After }` for each valid hunk and return `{ ok: true, code: "OK", conflicts: [], appliedFiles, fileSummaries }`.',
  '',
  '## 4. Pipeline Report Builder (`src/pipeline/report-builder.js`)',
  '- `buildPatchDiagnosticsReport({ hunks = [], fileContents = {}, rawDiagnostics = "", maxItems = 50 } = {})`:',
  '  - Calls `validatePatchBatch(hunks, fileContents)`, `parseDiagnosticLines(rawDiagnostics)`, and `deduplicateDiagnostics(..., { maxItems })`.',
  '  - Computes `ok = patchResult.ok && diagnosticsResult.items.every((d) => d.severity !== "error")`.',
  '  - Emits deterministic `reportDigest = sha256(canonicalJson({ ok, patchCode: patchResult.code, appliedPaths, items: diagnosticsResult.items, compression: diagnosticsResult.compression }))`.',
].join('\n') + '\n';

const ACI_05_CONSTRAINTS = [
  '# Multi-Module Patch & Diagnostics Constraints',
  '- **C1**: Zero external npm dependencies in `package.json`.',
  '- **C2**: Preserve public exports (`parseDiagnosticLines` in `src/diagnostics/parser.js`, `deduplicateDiagnostics` in `src/diagnostics/deduplicator.js`, `validatePatchBatch` in `src/patch/conflict-guard.js`, `buildPatchDiagnosticsReport` in `src/pipeline/report-builder.js`).',
  '- **C3**: `validatePatchBatch` MUST fail atomically with `OPTIMISTIC_LOCK_CONFLICT` and `appliedFiles: {}` whenever any hunk in the batch has a stale `expectedSha256`.',
  '- **C4**: Do NOT modify `SPEC.md`, `CONSTRAINTS.md`, `src/core/diagnostic-codes.js`, or `test/patch-diagnostics-baseline.test.js`.',
].join('\n') + '\n';

const ACI_05_CODES_MODULE = (() => {
  const lines = [
    "import { createHash } from 'node:crypto';",
    'export const PATCH_DIAGNOSTIC_CODES = Object.freeze({',
    '  OK: "OK",',
    '  OPTIMISTIC_LOCK_CONFLICT: "OPTIMISTIC_LOCK_CONFLICT",',
    '  PATH_CONFINEMENT_ERROR: "PATH_CONFINEMENT_ERROR",',
    '  INVALID_HUNK: "INVALID_HUNK",',
    '  DIAGNOSTIC_ERRORS_PRESENT: "DIAGNOSTIC_ERRORS_PRESENT",',
    '});',
    'export const SEVERITY_ORDER = Object.freeze({ error: 0, warning: 1, info: 2 });',
    'export function sha256Hex(value) {',
    '  return createHash("sha256").update(String(value ?? ""), "utf8").digest("hex");',
    '}',
    'export function canonicalStringify(value) {',
    '  if (value === null || typeof value !== "object") return JSON.stringify(value);',
    '  if (Array.isArray(value)) return "[" + value.map((v) => (v === undefined ? "null" : canonicalStringify(v))).join(",") + "]";',
    '  return "{" + Object.keys(value).filter((k) => value[k] !== undefined).sort().map((k) => JSON.stringify(k) + ":" + canonicalStringify(value[k])).join(",") + "}";',
    '}',
    'export const DIAGNOSTIC_RULE_CATALOG = Object.freeze({',
  ];
  for (let i = 1; i <= 36; i++) {
    lines.push(
      `  RULE_${String(i).padStart(2, '0')}: Object.freeze({ id: "DX-${200 + i}", category: "${i % 2 === 0 ? 'patch' : 'syntax'}", severity: "${i % 3 === 0 ? 'error' : 'warning'}", description: "Invariant check ${i} for atomic patch and diagnostic compression pipeline" }),`,
    );
  }
  lines.push('});');
  return lines.join('\n') + '\n';
})();

const ACI_06_CONTRACT_JSON = JSON.stringify(
  {
    schemaVersion: '1.0.0',
    contractId: 'aci-06-swarm-contract-integration',
    terminalStates: ['completed', 'failed', 'cancelled'],
    allowedModes: ['0o644', '0o755'],
    requiredWorkerFields: ['nodeKey', 'writeScope', 'changedFiles', 'outputDigest'],
    reviewerHardGate: {
      requireVerifiedGitDiff: true,
      requireZeroTestExitCode: true,
      rejectOnMergeConflicts: true,
      downgradeVerdictTo: 'fail',
    },
    conflictPolicy: 'three_way_merge_markers',
    invariants: Array.from({ length: 18 }, (_, i) => ({
      id: `SWARM_INV_${String(i + 1).padStart(2, '0')}`,
      enforced: true,
      description: `Swarm contract invariant ${i + 1}: enforce writeScope containment, conflict-aware 3-way merge, executable mode preservation, CAS terminal immutability, and hard reviewer git-diff + test exit gate.`,
    })),
  },
  null,
  2,
) + '\n';

const ACI_06_SPEC = [
  '# Parallel Swarm Contract Integration & Reviewer Hard-Gate Specification',
  '',
  '## 1. Schema & Scope Registry (`src/contracts/schema-registry.js`)',
  '- `validateWorkerContractOutput(contract, payload)` verifies:',
  '  - `payload.nodeKey` is non-empty string, `payload.writeScope` is non-empty array of confined relative paths.',
  '  - Every file path in `payload.changedFiles` (array of `{ path, content, mode? }`) stays inside `contract` bounds (no `..`, no leading `/`, no `.git`), AND falls under at least one `payload.writeScope` prefix (`path === scope || path.startsWith(scope + "/")`).',
  '  - Computes canonical `expectedDigest = sha256(canonicalJson({ nodeKey, changedFiles: sortedPathAndContent }))` and rejects if `payload.outputDigest !== expectedDigest` (`code: "CONTRACT_DIGEST_MISMATCH"`).',
  '',
  '## 2. Executable-Preserving 3-Way Merger (`src/merge/three-way-merger.js`)',
  '- `mergeParallelArtifacts(baseFiles = {}, workerOutputs = [])`:',
  '  - Normalizes file entries `{ content, mode }` (default mode `"0o644"`, preserving `"0o755"` if ANY contributing worker or base requires executable mode without deletion).',
  '  - When 1 worker edits a path, apply its content + mode directly.',
  '  - When 2+ workers edit the same path differently relative to `baseFiles[path]`, perform line-level 3-way merge:',
  '    - If workers modified disjoint line ranges (non-overlapping changed regions relative to base), merge BOTH edits cleanly with zero conflict!',
  '    - If workers modified overlapping line ranges with different replacement lines, emit conflict markers (`<<<<<<< <nodeA>`, `=======`, `>>>>>>> <nodeB>`), record `{ path, nodeKeys, reason: "overlapping_hunk_conflict" }` in `conflicts`, and NEVER silently overwrite!',
  '',
  '## 3. Reviewer Hard Gate (`src/gates/reviewer-gate.js`)',
  '- `evaluateReviewerHardGate({ claimedVerdict, gitDiffFiles = [], testExitCode = null, mergeConflicts = [] } = {})`:',
  '  - Even when `claimedVerdict === "pass"`, set `hardGatePassed = false` and downgrade `verdict = "fail"` if:',
  '    - `!Array.isArray(gitDiffFiles) || gitDiffFiles.length === 0` (`NO_VERIFIED_GIT_DIFF`)',
  '    - `testExitCode !== 0` (`TEST_EXECUTION_FAILED`)',
  '    - `Array.isArray(mergeConflicts) && mergeConflicts.length > 0` (`UNRESOLVED_MERGE_CONFLICTS`)',
  '  - Returns `{ verifiedGitDiff, diffFileCount, verifiedTestExitCode, hardGatePassed, verdict, reasons }`.',
  '',
  '## 4. Integration Runner & Terminal CAS (`src/coordinator/integration-runner.js`)',
  '- `transitionTerminalState(currentState, nextState)` enforces CAS: once `currentState` is `"completed" | "failed" | "cancelled"`, refuse transition (`{ ok: false, state: currentState, overwritten: false }`).',
  '- `runContractIntegration({ contract, baseFiles = {}, workerOutputs = [], claimedVerdict = "pass", testExitCode = 0 } = {})` validates all worker outputs, runs `mergeParallelArtifacts`, calls `evaluateReviewerHardGate`, and computes deterministic `integrationDigest`.',
].join('\n') + '\n';

const ACI_07_CONTRACT_JSON = JSON.stringify(
  {
    schemaVersion: 2,
    contractId: 'aci-07-cross-module-evolution',
    allowedStates: ['pending', 'running', 'completed', 'failed', 'cancelled'],
    terminalStates: ['completed', 'failed', 'cancelled'],
    transitions: {
      pending: ['running', 'cancelled'],
      running: ['completed', 'failed', 'cancelled'],
      completed: [],
      failed: [],
      cancelled: [],
    },
    partitionKeyPattern: '^[a-z0-9][a-z0-9._-]{1,63}$',
    requiredEnvelopeFields: [
      'schemaVersion',
      'eventId',
      'correlationId',
      'partitionKey',
      'state',
      'payload',
    ],
    allowV1MigrationDefault: true,
    evolutionInvariants: Array.from({ length: 22 }, (_, i) => ({
      id: `EVOL_INV_${String(i + 1).padStart(2, '0')}`,
      enforced: true,
      description: `Cross-module evolution invariant ${i + 1}: enforce terminal state immutability, strict v2 schemaVersion, explicit correlationId and partitionKey validation without default fallback, canonical SHA-256 envelope digest, and contract-required pipeline-runner caller propagation.`,
    })),
  },
  null,
  2,
) + '\n';

const ACI_07_SPEC = [
  '# Cross-Module Contract, Adapter, Event Pipeline & State Validator Evolution Specification',
  '',
  '## 1. State Validator (`src/validators/state-validator.js`)',
  '- `validateStateTransition(currentState, nextState, contract)`:',
  '  - Terminal states (`completed`, `failed`, `cancelled`, or `contract.terminalStates`) are immutable: attempting to transition out of any terminal state MUST return `{ ok: false, code: "TERMINAL_STATE_IMMUTABLE", state: currentState, overwritten: false }`.',
  '  - Non-terminal transitions must appear in `contract.transitions[currentState]` (default `pending -> [running, cancelled]`, `running -> [completed, failed, cancelled]`); otherwise return `{ ok: false, code: "INVALID_STATE_TRANSITION", state: currentState, overwritten: false }`.',
  '  - Allowed transitions return `{ ok: true, code: "OK", state: nextState, overwritten: false }`.',
  '- `validateEvolutionEnvelope(envelope, contract)`:',
  '  - Require object with `Number(envelope.schemaVersion) === 2` (`INVALID_SCHEMA_VERSION`), non-empty `eventId` (`INVALID_SCHEMA_VERSION`), non-empty trimmed `correlationId` (`MISSING_CORRELATION_ID`), `partitionKey` matching `contract.partitionKeyPattern` (`INVALID_PARTITION_KEY`), valid `state` in `contract.allowedStates`, and non-array object `payload`.',
  '',
  '## 2. V2 Envelope Adapter (`src/adapters/v2-envelope-adapter.js`)',
  '- `computeEnvelopeDigest(envelope)` computes `sha256Hex(canonicalJson({ schemaVersion: Number(envelope.schemaVersion), eventId, correlationId, partitionKey, state, payload }))` using `src/core/evolution-codes.js`.',
  '- `verifyEnvelopeChecksum(envelope)` returns `true` iff `typeof envelope?.checksum === "string"` and `envelope.checksum === computeEnvelopeDigest(envelope)`.',
  '- `adaptV1ToV2Envelope(rawEvent, { allowV1Migration = true } = {})`:',
  '  - For `schemaVersion === 2`: normalize string fields, preserve explicit `checksum` if supplied (or compute if omitted), and return `{ ok: true, migrationApplied: false, envelope }`.',
  '  - For v1 (`schemaVersion === 1` or omitted): if `!allowV1Migration` return `{ ok: false, code: "INVALID_SCHEMA_VERSION" }`. Derive `correlationId` from `correlationId || traceId || requestId` (`MISSING_CORRELATION_ID` if empty) and `partitionKey` from `partitionKey || tenantId` lowercased (`INVALID_PARTITION_KEY` if missing or invalid — NEVER fall back to `"default"`!). Return `{ ok: true, migrationApplied: true, envelope }` with `schemaVersion: 2` and `checksum`.',
  '',
  '## 3. Event Transformer (`src/pipeline/event-transformer.js`)',
  '- `transformPipelineBatch(events = [], options = {})` MUST require `options.contract` (if missing/non-object return `{ ok: false, code: "MISSING_CONTRACT", accepted: [], rejected: [], batchDigest: null }`).',
  '- For each event: adapt via `adaptV1ToV2Envelope`, validate via `validateEvolutionEnvelope`, verify `checksum` via `verifyEnvelopeChecksum` (`CHECKSUM_MISMATCH` on mismatch), and collect `accepted` (each with `digest` and `migrationApplied`) vs `rejected` (`{ eventId, code }`).',
  '- Return `{ ok: rejected.length === 0, code: rejected.length === 0 ? "OK" : "BATCH_REJECTED", accepted, rejected, batchDigest }`.',
  '',
  '## 4. Pipeline Runner Caller (`src/cli/pipeline-runner.js`)',
  '- `runEvolutionPipeline({ contract, currentState = "pending", nextState = "running", events = [], allowV1Migration = true } = {})` MUST pass `{ contract, allowV1Migration }` to `transformPipelineBatch`, fail closed before batch processing when `!contract` (`MISSING_CONTRACT`) or `!transition.ok`, and return `{ ok, code, state, accepted, rejected, batchDigest, pipelineDigest, summary }`.',
].join('\n') + '\n';

const ACI_07_EVOLUTION_CODES = (() => {
  const lines = [
    "import { createHash } from 'node:crypto';",
    'export const EVOLUTION_CODES = Object.freeze({',
    '  OK: "OK",',
    '  MISSING_CONTRACT: "MISSING_CONTRACT",',
    '  INVALID_STATE_TRANSITION: "INVALID_STATE_TRANSITION",',
    '  TERMINAL_STATE_IMMUTABLE: "TERMINAL_STATE_IMMUTABLE",',
    '  INVALID_SCHEMA_VERSION: "INVALID_SCHEMA_VERSION",',
    '  MISSING_CORRELATION_ID: "MISSING_CORRELATION_ID",',
    '  INVALID_PARTITION_KEY: "INVALID_PARTITION_KEY",',
    '  CHECKSUM_MISMATCH: "CHECKSUM_MISMATCH",',
    '  BATCH_REJECTED: "BATCH_REJECTED",',
    '});',
    'export function canonicalJson(value) {',
    '  if (value === null || typeof value !== "object") return JSON.stringify(value);',
    '  if (Array.isArray(value)) return "[" + value.map((v) => (v === undefined ? "null" : canonicalJson(v))).join(",") + "]";',
    '  return "{" + Object.keys(value).filter((k) => value[k] !== undefined).sort().map((k) => JSON.stringify(k) + ":" + canonicalJson(value[k])).join(",") + "}";',
    '}',
    'export function sha256Hex(value) {',
    '  return createHash("sha256").update(String(value ?? ""), "utf8").digest("hex");',
    '}',
    'export const EVOLUTION_INVARIANTS = Object.freeze({',
  ];
  for (let i = 1; i <= 40; i++) {
    lines.push(
      `  EVOL_${String(i).padStart(2, '0')}: Object.freeze({ id: "EV-${300 + i}", stage: "${i % 4 === 0 ? 'runner' : i % 3 === 0 ? 'pipeline' : i % 2 === 0 ? 'adapter' : 'validator'}", strict: true, note: "Cross-module v2 evolution rule #${i} preserving fail-closed validation and canonical digests" }),`,
    );
  }
  lines.push('});');
  return lines.join('\n') + '\n';
})();

const ACI_07_STATE_VALIDATOR_HEADER = (() => {
  const lines = [
    "import { EVOLUTION_CODES } from '../core/evolution-codes.js';",
    '',
    '// Historical V1 -> V2 state normalization metadata (lines 1-64); validator logic follows below.',
    'export const LEGACY_V1_STATE_ALIAS_TABLE = Object.freeze({',
  ];
  for (let i = 1; i <= 44; i++) {
    const srcState = ['queued', 'active', 'done', 'errored', 'aborted'][i % 5];
    const dstState = ['pending', 'running', 'completed', 'failed', 'cancelled'][i % 5];
    lines.push(
      `  LEGACY_STATE_${String(i).padStart(2, '0')}: Object.freeze({ legacy: "${srcState}_v${(i % 3) + 1}", canonical: "${dstState}", terminal: ${dstState === 'completed' || dstState === 'failed' || dstState === 'cancelled'}, deprecatedSince: "2.0.0" }),`,
    );
  }
  lines.push('});', '');
  return lines.join('\n');
})();

const ACI_07_ADAPTER_HEADER = (() => {
  const lines = [
    "import { EVOLUTION_CODES, canonicalJson, sha256Hex } from '../core/evolution-codes.js';",
    '',
    '// Historical V1 -> V2 envelope field migration table (lines 1-68); active adapter functions below.',
    'export const V1_TO_V2_FIELD_MIGRATION_MAP = Object.freeze({',
  ];
  for (let i = 1; i <= 48; i++) {
    const srcField = ['traceId', 'requestId', 'tenantId', 'id', 'jobState'][i % 5];
    const dstField = ['correlationId', 'correlationId', 'partitionKey', 'eventId', 'state'][i % 5];
    lines.push(
      `  FIELD_RULE_${String(i).padStart(2, '0')}: Object.freeze({ from: "${srcField}_${i}", to: "${dstField}", requiredInV2: true, allowDefaultFallback: false, note: "Strict v2 migration rule #${i}" }),`,
    );
  }
  lines.push('});', '');
  return lines.join('\n');
})();

const ACI_07_BASELINE_EVENTS = JSON.stringify(
  [
    {
      schemaVersion: 2,
      eventId: 'evt-base-01',
      correlationId: 'corr-base-01',
      partitionKey: 'tenant-alpha',
      state: 'pending',
      payload: { op: 'sync', batch: 1 },
    },
  ],
  null,
  2,
) + '\n';

// ---------------------------------------------------------------------------
// 4 Multi-File ACI Governance Tasks (`aci-01`..`aci-04`)
// ---------------------------------------------------------------------------

function buildTaskMetadata({
  id,
  area,
  requiredChangedFiles,
  testFiles,
  testCommand,
  repoFileCount,
  allowWorkspaceNodeCli = false,
  groundTruth,
}) {
  return {
    source: ACI_GOVERNANCE_BENCHMARK_ID,
    benchmarkVersion: VERSION,
    adapter: 'direct-agent-runtime',
    synthetic: true,
    externalNetwork: false,
    requiresWorkspaceMutation: true,
    requiresGitDiff: true,
    requiresIndependentVerification: true,
    area,
    groundTruth: Object.freeze({
      criticalFiles: Object.freeze([...groundTruth.criticalFiles]),
      relevantFiles: Object.freeze([...groundTruth.relevantFiles]),
      noiseFiles: Object.freeze([...groundTruth.noiseFiles]),
    }),
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

const RAW_ACI_BASE_TASKS = [
  // 1) aci-01-auth-tenant-boundary
  {
    id: 'aci-01-auth-tenant-boundary',
    area: 'auth_tenant_boundary',
    title: 'V2 Auth RBAC & Multi-Tenant Isolation Repair',
    objective: 'Fix cross-file tenant-isolation and default-deny RBAC flaws across src/auth/rbac-guard.js and src/middleware/tenant-context.js while respecting SPEC.md and src/core/runtime-options.js.',
    prompt: [
      'Investigate the active V2 authentication pipeline starting from `src/api/auth-routes.js` and `SPEC.md` (along with `src/core/runtime-options.js` and `src/auth/token-verifier.js`).',
      'Fix the cross-file tenant isolation and default-deny RBAC vulnerabilities ONLY in:',
      '- `src/middleware/tenant-context.js`: require `claims.tenantId` (no `"default-tenant"` fallback), reject cross-tenant `x-tenant-id` header mismatches, reject comma-joined/prototype tenant headers, and enforce `suspendedTenants` from `src/core/runtime-options.js`.',
      '- `src/auth/rbac-guard.js`: enforce strict default-deny (`allowUnknownAction` / prefix shortcuts / wildcard `"*"` must all be denied per `SECURITY_INVARIANTS`), validate `tenantContext` matches `claims.tenantId`, and scope `claims.tenantRoles` strictly to `tenantContext.tenantId`.',
      'Limit your source changes strictly to `src/middleware/tenant-context.js` and `src/auth/rbac-guard.js`; leave `token-verifier`, `runtime-options`, and `auth-routes` unchanged.',
      'Do NOT modify `SPEC.md` or `test/auth-baseline.test.js`.',
      'Run `node --test test/auth-baseline.test.js` after your edits.',
    ].join('\n'),
    fixture: {
      files: {
        'package.json': JSON.stringify({ name: 'aci-01-auth-v2', version: '2.0.0', type: 'module' }, null, 2) + '\n',
        'README.md': '# Auth Service V2\nActive entrypoint: `src/api/auth-routes.js`. See `SPEC.md` for tenant and RBAC invariants.\n',
        'SPEC.md': ACI_01_SPEC,
        'src/index.js': "export { handleAuthRequest } from './api/auth-routes.js';\nexport { signV2Token, verifyBearerToken } from './auth/token-verifier.js';\n",
        'src/core/runtime-options.js': ACI_01_RUNTIME_OPTIONS,
        'src/core/error-codes.js': [
          'export const AUTH_ERROR_CODES = Object.freeze({',
          '  TOKEN_INVALID: "TOKEN_INVALID",',
          '  TOKEN_EXPIRED: "TOKEN_EXPIRED",',
          '  TENANT_CONTEXT_MISSING: "TENANT_CONTEXT_MISSING",',
          '  TENANT_MISMATCH: "TENANT_MISMATCH",',
          '  TENANT_SUSPENDED: "TENANT_SUSPENDED",',
          '  TENANT_FORBIDDEN_KEY: "TENANT_FORBIDDEN_KEY",',
          '  RBAC_DENIED: "RBAC_DENIED",',
          '  RBAC_WILDCARD_FORBIDDEN: "RBAC_WILDCARD_FORBIDDEN",',
          '});',
          'export function authError(status, code, message) {',
          '  return { ok: false, status, code, message };',
          '}',
        ].join('\n') + '\n',
        'src/auth/token-verifier.js': [
          "import { createHmac, timingSafeEqual } from 'node:crypto';",
          "import { getRuntimeOptions } from '../core/runtime-options.js';",
          "import { AUTH_ERROR_CODES, authError } from '../core/error-codes.js';",
          'export function signV2Token(claims, secret = getRuntimeOptions().tokenSecret) {',
          '  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");',
          '  const sig = createHmac("sha256", secret).update(payload).digest("hex");',
          '  return `v2.${payload}.${sig}`;',
          '}',
          'export function verifyBearerToken(authHeader, { nowSec = Math.floor(Date.now() / 1000), runtimeOptions = getRuntimeOptions() } = {}) {',
          '  const raw = String(authHeader || "").trim();',
          '  const token = raw.startsWith("Bearer ") ? raw.slice(7).trim() : "";',
          '  const parts = token.split(".");',
          '  if (parts.length !== 3 || parts[0] !== "v2") return authError(401, AUTH_ERROR_CODES.TOKEN_INVALID, "Invalid token format");',
          '  const expectedSig = createHmac("sha256", runtimeOptions.tokenSecret).update(parts[1]).digest("hex");',
          '  const actualBuf = Buffer.from(parts[2], "utf8");',
          '  const expectedBuf = Buffer.from(expectedSig, "utf8");',
          '  if (actualBuf.length !== expectedBuf.length || !timingSafeEqual(actualBuf, expectedBuf)) {',
          '    return authError(401, AUTH_ERROR_CODES.TOKEN_INVALID, "Invalid token signature");',
          '  }',
          '  try {',
          '    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));',
          '    if (!claims || typeof claims !== "object" || typeof claims.sub !== "string" || !claims.sub) {',
          '      return authError(401, AUTH_ERROR_CODES.TOKEN_INVALID, "Missing subject claim");',
          '    }',
          '    if (claims.exp !== undefined && Number(claims.exp) <= nowSec) {',
          '      return authError(401, AUTH_ERROR_CODES.TOKEN_EXPIRED, "Token expired");',
          '    }',
          '    return { ok: true, claims };',
          '  } catch {',
          '    return authError(401, AUTH_ERROR_CODES.TOKEN_INVALID, "Malformed token payload");',
          '  }',
          '}',
        ].join('\n') + '\n',
        'src/middleware/tenant-context.js': [
          "import { getRuntimeOptions } from '../core/runtime-options.js';",
          'export function resolveTenantContext({ headers = {}, claims = null, runtimeOptions = getRuntimeOptions() } = {}) {',
          '  const headerVal = headers["x-tenant-id"] ?? headers["X-Tenant-Id"] ?? "";',
          '  const tenantId = String(headerVal || claims?.tenantId || "default-tenant").trim();',
          '  return { ok: true, tenantId, strict: Boolean(runtimeOptions.strictTenantIsolation) };',
          '}',
        ].join('\n') + '\n',
        'src/auth/rbac-guard.js': [
          "import { getRuntimeOptions } from '../core/runtime-options.js';",
          'export const ROLE_PERMISSIONS = Object.freeze({',
          '  viewer: Object.freeze(["docs:read", "metrics:read"]),',
          '  editor: Object.freeze(["docs:read", "docs:write", "metrics:read"]),',
          '  admin: Object.freeze(["docs:read", "docs:write", "docs:delete", "metrics:read", "billing:read", "billing:write"]),',
          '});',
          'export function authorizeRequest({ claims, tenantContext, action, runtimeOptions = getRuntimeOptions() } = {}) {',
          '  const roles = Array.isArray(claims?.roles) ? claims.roles : [];',
          '  if (roles.includes("*")) return { allowed: true, status: 200, code: "OK" };',
          '  if (String(action || "").startsWith("read:")) return { allowed: true, status: 200, code: "OK" };',
          '  for (const r of roles) {',
          '    const perms = ROLE_PERMISSIONS[r];',
          '    if (perms && perms.includes(action)) return { allowed: true, status: 200, code: "OK" };',
          '  }',
          '  if (runtimeOptions.allowUnknownAction !== false) return { allowed: true, status: 200, code: "OK" };',
          '  return { allowed: false, status: 403, code: "RBAC_DENIED", tenantId: tenantContext?.tenantId ?? null };',
          '}',
        ].join('\n') + '\n',
        'src/api/auth-routes.js': [
          "import { getRuntimeOptions } from '../core/runtime-options.js';",
          "import { verifyBearerToken } from '../auth/token-verifier.js';",
          "import { resolveTenantContext } from '../middleware/tenant-context.js';",
          "import { authorizeRequest } from '../auth/rbac-guard.js';",
          'export function handleAuthRequest({ headers = {}, action = "", nowSec, runtimeOptions = getRuntimeOptions() } = {}) {',
          '  const verified = verifyBearerToken(headers.authorization ?? headers.Authorization, { nowSec, runtimeOptions });',
          '  if (!verified.ok) return verified;',
          '  const tenantContext = resolveTenantContext({ headers, claims: verified.claims, runtimeOptions });',
          '  if (!tenantContext.ok) return tenantContext;',
          '  const authz = authorizeRequest({ claims: verified.claims, tenantContext, action, runtimeOptions });',
          '  if (!authz.allowed) return { ok: false, status: authz.status || 403, code: authz.code || "RBAC_DENIED" };',
          '  return { ok: true, status: 200, sub: verified.claims.sub, tenantId: tenantContext.tenantId, action };',
          '}',
        ].join('\n') + '\n',
        'test/auth-baseline.test.js': [
          "import test from 'node:test';",
          "import assert from 'node:assert/strict';",
          "import { handleAuthRequest, signV2Token } from '../src/index.js';",
          "test('baseline v2 auth request succeeds for matching tenant viewer', () => {",
          '  const tok = signV2Token({ sub: "u-1", tenantId: "tenant-a", roles: ["viewer"], exp: 2000000000 });',
          '  const res = handleAuthRequest({',
          '    headers: { authorization: `Bearer ${tok}`, "x-tenant-id": "tenant-a" },',
          '    action: "docs:read",',
          '    nowSec: 1700000000,',
          '  });',
          '  assert.equal(res.ok, true);',
          '  assert.equal(res.status, 200);',
          '  assert.equal(res.tenantId, "tenant-a");',
          '});',
        ].join('\n') + '\n',
        'src/legacy/v1-auth-compat.js': buildLegacyJsDecoy({
          moduleLabel: 'v1-auth-compat',
          domainKeywords: ['auth', 'token', 'tenant', 'rbac', 'bearer', 'x-tenant-id', 'session'],
          exportsList: ['verifyV1Token', 'resolveV1TenantFallback', 'legacyCheckPermission'],
        }),
        'src/legacy/v1-rbac-matrix-dump.js': buildLegacyJsDecoy({
          moduleLabel: 'v1-rbac-matrix-dump',
          domainKeywords: ['rbac', 'wildcard', 'default-tenant', 'admin', 'viewer', 'tenantRoles'],
          exportsList: ['getLegacyRoleMatrix', 'allowLegacyWildcard'],
          rows: 48,
        }),
        'src/compat/shadow-session-adapter.js': buildLegacyJsDecoy({
          moduleLabel: 'shadow-session-adapter',
          domainKeywords: ['resolveTenantContext', 'authorizeRequest', 'tenantId', 'claims', 'auth'],
          exportsList: ['resolveTenantContext', 'authorizeRequest'],
          rows: 40,
        }),
        'docs/OPENAPI-v1.json': buildOpenApiDecoy({
          serviceName: 'AuthGateway',
          keywords: ['auth', 'tenant', 'rbac', 'token', 'session'],
        }),
        'docs/CHANGELOG.md': buildChangelogDecoy({
          title: 'Auth Service',
          keywords: ['auth', 'tenant-context', 'rbac-guard', 'token-verifier', 'runtime-options'],
        }),
        'fixtures/audit-export-sample.csv': buildCsvDecoy({
          headerCols: ['id', 'timestamp', 'event', 'resource', 'tenant', 'token_digest', 'status', 'note'],
          keywords: ['auth', 'tenant', 'rbac', 'token'],
        }),
        'fixtures/v1-session-tokens.json': buildJsonFixtureDecoy({
          title: 'V1 Session Token Samples',
          keywords: ['auth', 'token', 'tenant', 'rbac'],
        }),
      },
      baselineTestFiles: ['test/auth-baseline.test.js'],
      baselineTestCommand: ['node', '--test', 'test/auth-baseline.test.js'],
    },
    judge: makeAciGovernanceJudge({
      requiredSourceFiles: ['src/auth/rbac-guard.js', 'src/middleware/tenant-context.js'],
      protectedReadOnlyFiles: [
        'SPEC.md',
        'src/core/runtime-options.js',
        'src/auth/token-verifier.js',
        'src/api/auth-routes.js',
        'test/auth-baseline.test.js',
      ],
      rootCauseFiles: ['src/auth/rbac-guard.js', 'src/middleware/tenant-context.js'],
      hiddenAcceptanceScript: `
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ws = process.env.WORKSPACE_ROOT || process.env.AGENT_US_EVAL_WORKSPACE;

test('hidden acceptance: tenant-context enforces strict single-tenant boundary and blocks suspended/missing/spoofed tenants', async () => {
  const { handleAuthRequest, signV2Token } = await import(pathToFileURL(join(ws, 'src/index.js')).href);
  const nowSec = 1700000000;

  const missingTenantTok = signV2Token({ sub: 'u1', roles: ['admin'], exp: 2000000000 });
  const rMissing = handleAuthRequest({ headers: { authorization: 'Bearer ' + missingTenantTok }, action: 'docs:read', nowSec });
  assert.equal(rMissing.ok, false);
  assert.equal(rMissing.status, 403);

  const tokA = signV2Token({ sub: 'u2', tenantId: 'tenant-a', roles: ['admin'], exp: 2000000000 });
  const rMismatch = handleAuthRequest({
    headers: { authorization: 'Bearer ' + tokA, 'x-tenant-id': 'tenant-b' },
    action: 'docs:read',
    nowSec,
  });
  assert.equal(rMismatch.ok, false);
  assert.equal(rMismatch.status, 403);
  assert.equal(rMismatch.code, 'TENANT_MISMATCH');

  const rMulti = handleAuthRequest({
    headers: { authorization: 'Bearer ' + tokA, 'x-tenant-id': 'tenant-a,tenant-b' },
    action: 'docs:read',
    nowSec,
  });
  assert.equal(rMulti.ok, false);
  assert.equal(rMulti.status, 403);

  const rProto = handleAuthRequest({
    headers: { authorization: 'Bearer ' + tokA, 'x-tenant-id': '__proto__' },
    action: 'docs:read',
    nowSec,
  });
  assert.equal(rProto.ok, false);

  const tokSusp = signV2Token({ sub: 'u3', tenantId: 'tenant-suspended', roles: ['admin'], exp: 2000000000 });
  const rSusp = handleAuthRequest({
    headers: { authorization: 'Bearer ' + tokSusp, 'x-tenant-id': 'tenant-suspended' },
    action: 'docs:read',
    nowSec,
  });
  assert.equal(rSusp.ok, false);
  assert.equal(rSusp.status, 403);
  assert.equal(rSusp.code, 'TENANT_SUSPENDED');
});

test('hidden acceptance: rbac-guard enforces default-deny, rejects wildcards, and scopes tenantRoles strictly', async () => {
  const { handleAuthRequest, signV2Token } = await import(pathToFileURL(join(ws, 'src/index.js')).href);
  const { authorizeRequest } = await import(pathToFileURL(join(ws, 'src/auth/rbac-guard.js')).href);
  const nowSec = 1700000000;

  const tokWild = signV2Token({ sub: 'u4', tenantId: 'tenant-a', roles: ['*'], exp: 2000000000 });
  const rWild = handleAuthRequest({
    headers: { authorization: 'Bearer ' + tokWild, 'x-tenant-id': 'tenant-a' },
    action: 'docs:read',
    nowSec,
  });
  assert.equal(rWild.ok, false);
  assert.equal(rWild.status, 403);

  const tokUnknown = signV2Token({ sub: 'u5', tenantId: 'tenant-a', roles: ['viewer'], exp: 2000000000 });
  const rUnknownAction = handleAuthRequest({
    headers: { authorization: 'Bearer ' + tokUnknown, 'x-tenant-id': 'tenant-a' },
    action: 'read:secrets',
    nowSec,
  });
  assert.equal(rUnknownAction.ok, false);
  assert.equal(rUnknownAction.status, 403);

  const rWriteDenied = handleAuthRequest({
    headers: { authorization: 'Bearer ' + tokUnknown, 'x-tenant-id': 'tenant-a' },
    action: 'docs:write',
    nowSec,
  });
  assert.equal(rWriteDenied.ok, false);

  const tokCrossRole = signV2Token({
    sub: 'u6',
    tenantId: 'tenant-a',
    tenantRoles: { 'tenant-b': ['admin'], 'tenant-a': ['viewer'] },
    exp: 2000000000,
  });
  const rCross = handleAuthRequest({
    headers: { authorization: 'Bearer ' + tokCrossRole, 'x-tenant-id': 'tenant-a' },
    action: 'billing:write',
    nowSec,
  });
  assert.equal(rCross.ok, false);
  assert.equal(rCross.status, 403);

  const directMismatch = authorizeRequest({
    claims: { sub: 'u6', tenantId: 'tenant-a', roles: ['admin'] },
    tenantContext: { ok: true, tenantId: 'tenant-b' },
    action: 'billing:write',
  });
  assert.equal(directMismatch.allowed, false);
});

test('hidden acceptance: legitimate tenant-scoped editor and admin calls succeed', async () => {
  const { handleAuthRequest, signV2Token } = await import(pathToFileURL(join(ws, 'src/index.js')).href);
  const nowSec = 1700000000;
  const tokAdmin = signV2Token({
    sub: 'u7',
    tenantId: 'tenant-c',
    tenantRoles: { 'tenant-c': ['admin'] },
    exp: 2000000000,
  });
  const rOk = handleAuthRequest({
    headers: { authorization: 'Bearer ' + tokAdmin },
    action: 'billing:write',
    nowSec,
  });
  assert.equal(rOk.ok, true);
  assert.equal(rOk.tenantId, 'tenant-c');
});
`,
    }),
    metadata: buildTaskMetadata({
      id: 'aci-01-auth-tenant-boundary',
      area: 'auth_tenant_boundary',
      requiredChangedFiles: ['src/auth/rbac-guard.js', 'src/middleware/tenant-context.js'],
      testFiles: ['test/auth-baseline.test.js'],
      testCommand: ['node', '--test', 'test/auth-baseline.test.js'],
      repoFileCount: 18,
      groundTruth: {
        criticalFiles: [
          'SPEC.md',
          'src/core/runtime-options.js',
          'src/auth/token-verifier.js',
          'src/auth/rbac-guard.js',
          'src/middleware/tenant-context.js',
          'src/api/auth-routes.js',
        ],
        relevantFiles: [
          'package.json',
          'README.md',
          'SPEC.md',
          'src/index.js',
          'src/core/runtime-options.js',
          'src/core/error-codes.js',
          'src/auth/token-verifier.js',
          'src/auth/rbac-guard.js',
          'src/middleware/tenant-context.js',
          'src/api/auth-routes.js',
          'test/auth-baseline.test.js',
        ],
        noiseFiles: [
          'src/legacy/v1-auth-compat.js',
          'src/legacy/v1-rbac-matrix-dump.js',
          'src/compat/shadow-session-adapter.js',
          'docs/OPENAPI-v1.json',
          'docs/CHANGELOG.md',
          'fixtures/audit-export-sample.csv',
          'fixtures/v1-session-tokens.json',
        ],
      },
    }),
  },

  // 2) aci-02-persistence-wal-ledger
  {
    id: 'aci-02-persistence-wal-ledger',
    area: 'persistence_wal_ledger',
    title: 'Persistence WAL Replay, Corrupt-Tail Recovery & Checkpoint Idempotency',
    objective: 'Fix numeric WAL ordering, CRC32 checksum validation, corrupt-tail recovery, and idempotent checkpoint reconciliation while honoring C1..C4.',
    prompt: [
      'Inspect `SPEC.md`, `CONSTRAINTS.md`, `src/persistence/crc32.js`, `src/api/ledger-contract.js`, `src/persistence/wal-store.js`, and `src/persistence/checkpoint-reconciler.js`.',
      'Fix the persistence WAL replay and checkpoint reconciliation bugs in:',
      '- `src/persistence/wal-store.js`: enforce real CRC32 verification via `computeWalRecordCrc`, sort replayed records numerically ascending by `seq`, recover cleanly when ONLY the trailing final line is corrupt/truncated (`truncatedTail: true`), and throw `WAL_CRC_MISMATCH` on mid-stream corruption.',
      '- `src/persistence/checkpoint-reconciler.js`: replay numerically by `seq`, enforce idempotency against both `seq <= lastAppliedSeq` and `appliedKeys`, update balances via `applyLedgerEntry`, compute `digest` via `computeLedgerDigest`, and implement `compactWal` preserving only unapplied valid records.',
      'Limit your source changes strictly to `src/persistence/wal-store.js` and `src/persistence/checkpoint-reconciler.js`; leave `crc32` and `ledger-contract` unchanged.',
      'Do NOT modify `SPEC.md`, `CONSTRAINTS.md`, or `test/wal-baseline.test.js`.',
      'Run `node --test test/wal-baseline.test.js`.',
    ].join('\n'),
    fixture: {
      files: {
        'package.json': JSON.stringify({ name: 'aci-02-wal-ledger', version: '1.0.0', type: 'module' }, null, 2) + '\n',
        'README.md': '# Persistence WAL & Ledger\nSee `SPEC.md`, `CONSTRAINTS.md`, and `src/api/ledger-contract.js`.\n',
        'SPEC.md': ACI_02_SPEC,
        'CONSTRAINTS.md': ACI_02_CONSTRAINTS,
        'src/index.js': "export { appendWalRecord, replayWal, verifyWalChecksum } from './persistence/wal-store.js';\nexport { reconcileCheckpoint, compactWal } from './persistence/checkpoint-reconciler.js';\nexport { applyLedgerEntry, computeLedgerDigest, verifyLedgerState } from './api/ledger-contract.js';\n",
        'src/persistence/crc32.js': [
          'const TABLE = (() => {',
          '  const tbl = new Uint32Array(256);',
          '  for (let i = 0; i < 256; i++) {',
          '    let c = i;',
          '    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);',
          '    tbl[i] = c >>> 0;',
          '  }',
          '  return tbl;',
          '})();',
          'export function crc32Hex(input) {',
          '  const buf = Buffer.from(String(input ?? ""), "utf8");',
          '  let crc = 0xffffffff;',
          '  for (let i = 0; i < buf.length; i++) crc = TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);',
          '  return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, "0");',
          '}',
          'export function computeWalRecordCrc(record) {',
          '  return crc32Hex(JSON.stringify({',
          '    seq: Number(record?.seq),',
          '    idempotencyKey: String(record?.idempotencyKey ?? ""),',
          '    account: String(record?.account ?? ""),',
          '    deltaCents: Number(record?.deltaCents),',
          '  }));',
          '}',
        ].join('\n') + '\n',
        'src/api/ledger-contract.js': [
          "import { createHash } from 'node:crypto';",
          '// Pure Ledger Contract (C1/C2: pure computation only, zero filesystem or subprocess imports)',
          'export function applyLedgerEntry(balances = {}, entry) {',
          '  const next = { ...balances };',
          '  const account = String(entry?.account ?? "").trim();',
          '  const delta = Number(entry?.deltaCents);',
          '  if (!account || !Number.isInteger(delta)) throw new TypeError("Invalid ledger entry");',
          '  next[account] = (Number(next[account] ?? 0) || 0) + delta;',
          '  return next;',
          '}',
          'export function computeLedgerDigest({ lastAppliedSeq = 0, appliedKeys = [], balances = {} } = {}) {',
          '  const sortedBalances = {};',
          '  for (const k of Object.keys(balances).sort()) sortedBalances[k] = balances[k];',
          '  const payload = {',
          '    lastAppliedSeq: Number(lastAppliedSeq || 0),',
          '    appliedKeys: [...new Set(appliedKeys.map(String))].sort(),',
          '    balances: sortedBalances,',
          '  };',
          '  return createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");',
          '}',
          'export function verifyLedgerState(state) {',
          '  if (!state || typeof state !== "object") return false;',
          '  return state.digest === computeLedgerDigest(state);',
          '}',
        ].join('\n') + '\n',
        'src/persistence/wal-store.js':
          ACI_02_WAL_STORE_HEADER +
          [
            'export function verifyWalChecksum(record) {',
            '  return Boolean(record && typeof record.crc === "string" && record.crc.length > 0);',
            '}',
            'export function appendWalRecord(walPath, entry) {',
            '  const rec = { seq: entry.seq, idempotencyKey: entry.idempotencyKey, account: entry.account, deltaCents: entry.deltaCents };',
            '  const crc = computeWalRecordCrc(rec);',
            '  const full = { ...rec, crc };',
            '  appendFileSync(walPath, JSON.stringify(full) + "\\n", "utf8");',
            '  return full;',
            '}',
            'export function replayWal(walPath) {',
            '  if (!existsSync(walPath)) return { records: [], truncatedTail: false, corruptTailCount: 0 };',
            '  const lines = readFileSync(walPath, "utf8").split(/\\r?\\n/).filter((l) => l.trim().length > 0);',
            '  const records = lines.map((line) => JSON.parse(line));',
            '  records.sort((a, b) => String(a.seq).localeCompare(String(b.seq)));',
            '  return { records, truncatedTail: false, corruptTailCount: 0 };',
            '}',
          ].join('\n') + '\n',
        'src/persistence/checkpoint-reconciler.js': [
          "import { writeFileSync } from 'node:fs';",
          "import { applyLedgerEntry } from '../api/ledger-contract.js';",
          'export function reconcileCheckpoint(checkpointState = {}, walRecords = []) {',
          '  let balances = { ...(checkpointState?.balances ?? {}) };',
          '  let lastAppliedSeq = Number(checkpointState?.lastAppliedSeq ?? 0);',
          '  let appliedCount = 0;',
          '  for (const rec of walRecords) {',
          '    balances = applyLedgerEntry(balances, rec);',
          '    lastAppliedSeq = Math.max(lastAppliedSeq, Number(rec.seq || 0));',
          '    appliedCount += 1;',
          '  }',
          '  return { lastAppliedSeq, appliedKeys: [...(checkpointState?.appliedKeys ?? [])], balances, digest: "stale", appliedCount, skippedDuplicates: 0 };',
          '}',
          'export function compactWal(walPath) {',
          '  writeFileSync(walPath, "", "utf8");',
          '  return { remainingCount: 0 };',
          '}',
        ].join('\n') + '\n',
        'test/wal-baseline.test.js': [
          "import test from 'node:test';",
          "import assert from 'node:assert/strict';",
          "import { mkdtempSync, rmSync } from 'node:fs';",
          "import { tmpdir } from 'node:os';",
          "import { join } from 'node:path';",
          "import { appendWalRecord, replayWal, reconcileCheckpoint } from '../src/index.js';",
          "test('baseline wal append, replay, and reconcile', () => {",
          '  const dir = mkdtempSync(join(tmpdir(), "aci02-base-"));',
          '  try {',
          '    const wal = join(dir, "ledger.wal");',
          '    appendWalRecord(wal, { seq: 1, idempotencyKey: "k-1", account: "acct-1", deltaCents: 500 });',
          '    const replayed = replayWal(wal);',
          '    const ckpt = reconcileCheckpoint({ lastAppliedSeq: 0, appliedKeys: [], balances: {} }, replayed.records);',
          '    assert.equal(ckpt.balances["acct-1"], 500);',
          '    assert.equal(ckpt.lastAppliedSeq, 1);',
          '  } finally { rmSync(dir, { recursive: true, force: true }); }',
          '});',
        ].join('\n') + '\n',
        'scripts/legacy-wal-migration-dump.sql': buildSqlDecoy({
          tableName: 'legacy_wal_entries',
          keywords: ['wal', 'crc32', 'checkpoint', 'ledger', 'idempotencyKey'],
        }),
        'src/legacy/v0-wal-pretty-printer.js': buildLegacyJsDecoy({
          moduleLabel: 'v0-wal-pretty-printer',
          domainKeywords: ['wal', 'replayWal', 'crc32', 'checkpoint', 'ledger'],
          exportsList: ['formatLegacyWal', 'printLegacyLedger'],
        }),
        'src/telemetry/wal-metrics-exporter.js': buildLegacyJsDecoy({
          moduleLabel: 'wal-metrics-exporter',
          domainKeywords: ['wal', 'checkpoint', 'reconcile', 'latency', 'crc'],
          exportsList: ['collectWalMetrics', 'formatPrometheusWal'],
        }),
        'src/persistence/legacy-journal-adapter.js': buildLegacyJsDecoy({
          moduleLabel: 'legacy-journal-adapter',
          domainKeywords: ['replayWal', 'reconcileCheckpoint', 'compactWal', 'idempotencyKey'],
          exportsList: ['replayWal', 'reconcileCheckpoint'],
        }),
        'fixtures/corrupt-wal-archive.jsonl': buildCsvDecoy({
          headerCols: ['seq', 'timestamp', 'op', 'account', 'tenant', 'crc', 'status', 'note'],
          keywords: ['wal', 'crc', 'checkpoint', 'ledger'],
          rows: 90,
        }),
        'fixtures/legacy-ledger-snapshots.json': buildJsonFixtureDecoy({
          title: 'Legacy Ledger Snapshots',
          keywords: ['ledger', 'wal', 'checkpoint', 'crc32'],
        }),
        'docs/WAL-OPERATIONS-ARCHIVE.md': buildMarkdownArchiveDecoy({
          title: 'WAL Operations Runbook',
          keywords: ['wal-store', 'checkpoint-reconciler', 'crc32', 'corrupt-tail'],
        }),
        'docs/CHANGELOG.md': buildChangelogDecoy({
          title: 'Persistence Engine',
          keywords: ['wal-store', 'crc32', 'checkpoint-reconciler', 'ledger-contract'],
        }),
      },
      baselineTestFiles: ['test/wal-baseline.test.js'],
      baselineTestCommand: ['node', '--test', 'test/wal-baseline.test.js'],
    },
    judge: makeAciGovernanceJudge({
      requiredSourceFiles: ['src/persistence/wal-store.js', 'src/persistence/checkpoint-reconciler.js'],
      protectedReadOnlyFiles: [
        'SPEC.md',
        'CONSTRAINTS.md',
        'src/persistence/crc32.js',
        'src/api/ledger-contract.js',
        'test/wal-baseline.test.js',
      ],
      rootCauseFiles: ['src/persistence/wal-store.js', 'src/persistence/checkpoint-reconciler.js'],
      extraCheck: ({ workspaceRoot }) => {
        const pkg = readWorkspaceJson(workspaceRoot, 'package.json');
        const ledgerContract = readWorkspaceText(workspaceRoot, 'src/api/ledger-contract.js') ?? '';
        const walStore = readWorkspaceText(workspaceRoot, 'src/persistence/wal-store.js') ?? '';
        const reconciler = readWorkspaceText(workspaceRoot, 'src/persistence/checkpoint-reconciler.js') ?? '';
        const c1 = !pkg?.dependencies || Object.keys(pkg.dependencies).length === 0;
        const c2 =
          /export\s+function\s+appendWalRecord/.test(walStore) &&
          /export\s+function\s+replayWal/.test(walStore) &&
          /export\s+function\s+verifyWalChecksum/.test(walStore) &&
          /export\s+function\s+reconcileCheckpoint/.test(reconciler) &&
          /export\s+function\s+compactWal/.test(reconciler);
        const cPure = !/(?:import|require)[^;'"\\n]*['"]node:(?:fs|child_process)/.test(ledgerContract);
        return { constraintsPreserved: c1 && c2 && cPure };
      },
      hiddenAcceptanceScript: `
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ws = process.env.WORKSPACE_ROOT || process.env.AGENT_US_EVAL_WORKSPACE;

test('hidden acceptance: numeric seq ordering, idempotent checkpoint reconciliation, and digest verification', async () => {
  const { appendWalRecord, replayWal, reconcileCheckpoint, compactWal, verifyLedgerState } = await import(
    pathToFileURL(join(ws, 'src/index.js')).href
  );
  const dir = mkdtempSync(join(tmpdir(), 'aci02-hid1-'));
  try {
    const wal = join(dir, 'wal.jsonl');
    appendWalRecord(wal, { seq: 10, idempotencyKey: 'k10', account: 'ops', deltaCents: 200 });
    appendWalRecord(wal, { seq: 2, idempotencyKey: 'k2', account: 'ops', deltaCents: 150 });
    appendWalRecord(wal, { seq: 11, idempotencyKey: 'k10', account: 'ops', deltaCents: 999 });
    appendWalRecord(wal, { seq: 1, idempotencyKey: 'k1', account: 'ops', deltaCents: 100 });

    const replayed = replayWal(wal);
    assert.deepEqual(replayed.records.map((r) => r.seq), [1, 2, 10, 11]);

    const initialCkpt = { lastAppliedSeq: 1, appliedKeys: ['k1'], balances: { ops: 100 } };
    const next = reconcileCheckpoint(initialCkpt, replayed.records);
    assert.equal(next.lastAppliedSeq, 10);
    assert.equal(next.balances.ops, 450);
    assert.equal(next.skippedDuplicates, 2);
    assert.equal(verifyLedgerState(next), true);

    const compacted = compactWal(wal, { lastAppliedSeq: 2, appliedKeys: ['k1', 'k2'], balances: {} });
    assert.equal(compacted.remainingCount, 2);
    const afterCompact = replayWal(wal);
    assert.deepEqual(afterCompact.records.map((r) => r.seq), [10, 11]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('hidden acceptance: corrupt-tail recovers safely while mid-stream CRC tampering throws', async () => {
  const { appendWalRecord, replayWal, verifyWalChecksum } = await import(
    pathToFileURL(join(ws, 'src/persistence/wal-store.js')).href
  );
  assert.equal(verifyWalChecksum({ seq: 1, idempotencyKey: 'a', account: 'x', deltaCents: 1, crc: 'deadbeef' }), false);

  const dir = mkdtempSync(join(tmpdir(), 'aci02-hid2-'));
  try {
    const walTail = join(dir, 'tail.wal');
    appendWalRecord(walTail, { seq: 1, idempotencyKey: 'k1', account: 'a', deltaCents: 50 });
    appendWalRecord(walTail, { seq: 2, idempotencyKey: 'k2', account: 'a', deltaCents: 75 });
    appendFileSync(walTail, '{"seq":3,"idempotencyKey":"k3","account":"a","delta', 'utf8');

    const recovered = replayWal(walTail, { allowCorruptTail: true });
    assert.equal(recovered.truncatedTail, true);
    assert.deepEqual(recovered.records.map((r) => r.seq), [1, 2]);

    const walMid = join(dir, 'mid.wal');
    appendWalRecord(walMid, { seq: 1, idempotencyKey: 'k1', account: 'a', deltaCents: 50 });
    const badLine = JSON.stringify({ seq: 2, idempotencyKey: 'k2', account: 'a', deltaCents: 9999, crc: '00000000' });
    appendFileSync(walMid, badLine + '\\n', 'utf8');
    appendWalRecord(walMid, { seq: 3, idempotencyKey: 'k3', account: 'a', deltaCents: 25 });
    assert.throws(() => replayWal(walMid, { allowCorruptTail: true }), /WAL_CRC_MISMATCH|corrupt/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('hidden acceptance: C1..C4 package and purity constraints hold', () => {
  const pkg = JSON.parse(readFileSync(join(ws, 'package.json'), 'utf8'));
  assert.equal(Object.keys(pkg.dependencies || {}).length, 0);
  const ledgerSrc = readFileSync(join(ws, 'src/api/ledger-contract.js'), 'utf8');
  assert.equal(/(?:import|require)[^;'"]*['"]node:(?:fs|child_process)/.test(ledgerSrc), false);
});
`,
    }),
    metadata: buildTaskMetadata({
      id: 'aci-02-persistence-wal-ledger',
      area: 'persistence_wal_ledger',
      requiredChangedFiles: ['src/persistence/wal-store.js', 'src/persistence/checkpoint-reconciler.js'],
      testFiles: ['test/wal-baseline.test.js'],
      testCommand: ['node', '--test', 'test/wal-baseline.test.js'],
      repoFileCount: 18,
      groundTruth: {
        criticalFiles: [
          'SPEC.md',
          'CONSTRAINTS.md',
          'src/persistence/crc32.js',
          'src/persistence/wal-store.js',
          'src/persistence/checkpoint-reconciler.js',
          'src/api/ledger-contract.js',
        ],
        relevantFiles: [
          'package.json',
          'README.md',
          'SPEC.md',
          'CONSTRAINTS.md',
          'src/index.js',
          'src/persistence/crc32.js',
          'src/persistence/wal-store.js',
          'src/persistence/checkpoint-reconciler.js',
          'src/api/ledger-contract.js',
          'test/wal-baseline.test.js',
        ],
        noiseFiles: [
          'scripts/legacy-wal-migration-dump.sql',
          'src/legacy/v0-wal-pretty-printer.js',
          'src/telemetry/wal-metrics-exporter.js',
          'src/persistence/legacy-journal-adapter.js',
          'fixtures/corrupt-wal-archive.jsonl',
          'fixtures/legacy-ledger-snapshots.json',
          'docs/WAL-OPERATIONS-ARCHIVE.md',
          'docs/CHANGELOG.md',
        ],
      },
    }),
  },

  // 3) aci-03-contract-pipeline-refactor
  {
    id: 'aci-03-contract-pipeline-refactor',
    area: 'contract_pipeline_refactor',
    title: '4-Hop Config Normalization, Precedence & Checksum Pipeline Refactor',
    objective: 'Refactor loader -> normalizer -> precedence-resolver -> evaluator to satisfy CONTRACT.json highest-to-lowest precedence and canonical checksum invariants.',
    prompt: [
      'Inspect `CONTRACT.json` and trace the 4-hop pipeline in `src/index.js`:',
      '`src/pipeline/loader.js` -> `src/pipeline/normalizer.js` -> `src/pipeline/precedence-resolver.js` -> `src/pipeline/evaluator.js` (with `src/pipeline/schema-validator.js`).',
      'Refactor all 4 pipeline modules so they comply with `CONTRACT.json`:',
      '1. `src/pipeline/normalizer.js`: implement `normalizeKey` (snake_case lowercase) and `normalizeConfigLayer` blocking prototype keys (`__proto__`, `constructor`, `prototype`), ignoring `undefined`/`null`, while preserving falsy `0`, `false`, `""`.',
      '2. `src/pipeline/loader.js`: normalize each layer (`defaults`, `workspace`, `env`, `cli`) through `normalizeConfigLayer` from `./normalizer.js`.',
      '3. `src/pipeline/precedence-resolver.js`: resolve highest-to-lowest precedence `["cli", "env", "workspace", "defaults"]` and emit `{ effectiveConfig, provenance }`.',
      '4. `src/pipeline/evaluator.js`: validate normalized `effectiveConfig` using `schema-validator.js`, emit `{ effectiveConfig, provenance, evaluatedRules, checksum }` with deterministic SHA-256 checksum over canonical sorted keys.',
      'Limit your source changes strictly to `src/pipeline/loader.js`, `src/pipeline/normalizer.js`, `src/pipeline/precedence-resolver.js`, and `src/pipeline/evaluator.js`; leave `schema-validator` unchanged.',
      'Do NOT modify `CONTRACT.json` or `test/pipeline-baseline.test.js`.',
      'Run `node --test test/pipeline-baseline.test.js`.',
    ].join('\n'),
    fixture: {
      files: {
        'package.json': JSON.stringify({ name: 'aci-03-pipeline', version: '1.0.0', type: 'module' }, null, 2) + '\n',
        'README.md': '# Contract Pipeline\n4-hop flow in `src/index.js` governed by `CONTRACT.json`.\n',
        'CONTRACT.json': ACI_03_CONTRACT_JSON,
        'src/index.js': [
          "import { loadConfigLayers } from './pipeline/loader.js';",
          "import { resolvePrecedence } from './pipeline/precedence-resolver.js';",
          "import { evaluateConfig } from './pipeline/evaluator.js';",
          'export function runContractPipeline(rawSources = {}) {',
          '  const layers = loadConfigLayers(rawSources);',
          '  const resolved = resolvePrecedence(layers);',
          '  return evaluateConfig(resolved);',
          '}',
        ].join('\n') + '\n',
        'src/pipeline/schema-validator.js': [
          'export const CONTRACT_RULES = Object.freeze({',
          '  max_concurrency: { type: "integer", min: 1, max: 128 },',
          '  timeout_ms: { type: "integer", min: 100, max: 300000 },',
          '  strict_mode: { type: "boolean" },',
          '  retry_limit: { type: "integer", min: 0, max: 10 },',
          '  audit_level: { enum: ["off", "basic", "strict"] },',
          '});',
          'export function validateRule(key, value) {',
          '  const spec = CONTRACT_RULES[key];',
          '  if (!spec) return { ruleId: key, passed: true, value };',
          '  if (spec.type === "integer") {',
          '    const ok = Number.isInteger(value) && value >= spec.min && value <= spec.max;',
          '    return { ruleId: key, passed: ok, value };',
          '  }',
          '  if (spec.type === "boolean") {',
          '    return { ruleId: key, passed: typeof value === "boolean", value };',
          '  }',
          '  if (Array.isArray(spec.enum)) {',
          '    return { ruleId: key, passed: spec.enum.includes(value), value };',
          '  }',
          '  return { ruleId: key, passed: true, value };',
          '}',
        ].join('\n') + '\n',
        'src/pipeline/normalizer.js': [
          'export function normalizeKey(key) { return String(key ?? "").trim(); }',
          'export function normalizeConfigLayer(rawLayer = {}) {',
          '  const out = {};',
          '  for (const [k, v] of Object.entries(rawLayer || {})) {',
          '    if (!v) continue;',
          '    out[normalizeKey(k)] = v;',
          '  }',
          '  return out;',
          '}',
        ].join('\n') + '\n',
        'src/pipeline/loader.js': [
          'export function loadConfigLayers(rawSources = {}) {',
          '  return {',
          '    defaults: { ...(rawSources.defaults || {}) },',
          '    workspace: { ...(rawSources.workspace || {}) },',
          '    env: { ...(rawSources.env || {}) },',
          '    cli: { ...(rawSources.cli || {}) },',
          '  };',
          '}',
        ].join('\n') + '\n',
        'src/pipeline/precedence-resolver.js': [
          'export const PRECEDENCE_ORDER = Object.freeze(["defaults", "workspace", "env", "cli"]);',
          'export function resolvePrecedence(layers = {}) {',
          '  const effectiveConfig = {};',
          '  for (const name of [...PRECEDENCE_ORDER].reverse()) {',
          '    Object.assign(effectiveConfig, layers[name] || {});',
          '  }',
          '  return { effectiveConfig, provenance: {} };',
          '}',
        ].join('\n') + '\n',
        'src/pipeline/evaluator.js': [
          "import { createHash } from 'node:crypto';",
          "import { validateRule } from './schema-validator.js';",
          'export function evaluateConfig(resolved = {}) {',
          '  const effectiveConfig = resolved.effectiveConfig || {};',
          '  const provenance = resolved.provenance || {};',
          '  const evaluatedRules = Object.keys(effectiveConfig).map((k) => validateRule(k, effectiveConfig[k]));',
          '  const checksum = createHash("sha256").update(JSON.stringify(effectiveConfig)).digest("hex");',
          '  return { effectiveConfig, provenance, evaluatedRules, checksum };',
          '}',
        ].join('\n') + '\n',
        'test/pipeline-baseline.test.js': [
          "import test from 'node:test';",
          "import assert from 'node:assert/strict';",
          "import { runContractPipeline } from '../src/index.js';",
          "test('baseline contract pipeline evaluates default config', () => {",
          '  const res = runContractPipeline({',
          '    defaults: { timeout_ms: 5000, max_concurrency: 4, strict_mode: true, retry_limit: 1, audit_level: "basic" },',
          '  });',
          '  assert.equal(res.effectiveConfig.timeout_ms, 5000);',
          '  assert.equal(res.evaluatedRules.every((r) => r.passed), true);',
          '});',
        ].join('\n') + '\n',
        'plugins/slack-adapter.js': buildLegacyJsDecoy({
          moduleLabel: 'slack-adapter',
          domainKeywords: ['pipeline', 'config', 'webhook', 'normalizer', 'evaluator'],
          exportsList: ['sendSlackPipelineAlert', 'formatSlackConfig'],
        }),
        'plugins/prometheus-exporter.js': buildLegacyJsDecoy({
          moduleLabel: 'prometheus-exporter',
          domainKeywords: ['precedence', 'pipeline', 'metrics', 'timeout_ms', 'max_concurrency'],
          exportsList: ['exportPipelineMetrics', 'renderPrometheusGauge'],
        }),
        'plugins/s3-archiver.js': buildLegacyJsDecoy({
          moduleLabel: 's3-archiver',
          domainKeywords: ['checksum', 'pipeline', 'contract', 'config', 'archive'],
          exportsList: ['archivePipelineSnapshot', 'computeS3Key'],
        }),
        'plugins/email-notifier.js': buildLegacyJsDecoy({
          moduleLabel: 'email-notifier',
          domainKeywords: ['evaluator', 'audit_level', 'retry_limit', 'notification'],
          exportsList: ['sendPipelineDigestEmail', 'renderEmailHtml'],
        }),
        'fixtures/sample-configs.json': buildJsonFixtureDecoy({
          title: 'Sample Pipeline Configs',
          keywords: ['cli', 'env', 'workspace', 'defaults', 'precedence'],
        }),
        'docs/CHANGELOG.md': buildChangelogDecoy({
          title: 'Contract Pipeline',
          keywords: ['normalizer', 'precedence-resolver', 'evaluator', 'loader'],
        }),
        'src/pipeline/legacy-v0-evaluator.js': buildLegacyJsDecoy({
          moduleLabel: 'legacy-v0-evaluator',
          domainKeywords: ['evaluateConfig', 'resolvePrecedence', 'normalizeConfigLayer', 'CONTRACT'],
          exportsList: ['evaluateConfig', 'resolvePrecedence'],
        }),
      },
      baselineTestFiles: ['test/pipeline-baseline.test.js'],
      baselineTestCommand: ['node', '--test', 'test/pipeline-baseline.test.js'],
    },
    judge: makeAciGovernanceJudge({
      requiredSourceFiles: [
        'src/pipeline/loader.js',
        'src/pipeline/normalizer.js',
        'src/pipeline/precedence-resolver.js',
        'src/pipeline/evaluator.js',
      ],
      protectedReadOnlyFiles: [
        'CONTRACT.json',
        'src/pipeline/schema-validator.js',
        'test/pipeline-baseline.test.js',
      ],
      rootCauseFiles: [
        'src/pipeline/loader.js',
        'src/pipeline/normalizer.js',
        'src/pipeline/precedence-resolver.js',
        'src/pipeline/evaluator.js',
      ],
      hiddenAcceptanceScript: `
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ws = process.env.WORKSPACE_ROOT || process.env.AGENT_US_EVAL_WORKSPACE;

test('hidden acceptance: 4-hop pipeline normalizes keys, preserves falsy overrides, and resolves cli > env > workspace > defaults', async () => {
  const { runContractPipeline } = await import(pathToFileURL(join(ws, 'src/index.js')).href);
  const res = runContractPipeline({
    defaults: { 'Timeout-Ms': 5000, 'Max Concurrency': 8, strict_mode: true, retry_limit: 3, audit_level: 'basic' },
    workspace: { 'timeout-ms': 12000, 'Audit-Level': 'strict' },
    env: { max_concurrency: 16, strict_mode: false, ignored_null: null },
    cli: { 'retry-limit': 0, timeout_ms: 800 },
  });

  assert.equal(res.effectiveConfig.timeout_ms, 800);
  assert.equal(res.effectiveConfig.max_concurrency, 16);
  assert.equal(res.effectiveConfig.strict_mode, false);
  assert.equal(res.effectiveConfig.retry_limit, 0);
  assert.equal(res.effectiveConfig.audit_level, 'strict');
  assert.equal(Object.hasOwn(res.effectiveConfig, 'ignored_null'), false);

  assert.equal(res.provenance.timeout_ms, 'cli');
  assert.equal(res.provenance.retry_limit, 'cli');
  assert.equal(res.provenance.max_concurrency, 'env');
  assert.equal(res.provenance.strict_mode, 'env');
  assert.equal(res.provenance.audit_level, 'workspace');
  assert.equal(res.evaluatedRules.every((r) => r.passed), true);
});

test('hidden acceptance: normalizer blocks prototype pollution and checksum is canonical across key order', async () => {
  const { runContractPipeline } = await import(pathToFileURL(join(ws, 'src/index.js')).href);
  const { normalizeConfigLayer } = await import(pathToFileURL(join(ws, 'src/pipeline/normalizer.js')).href);
  const { PRECEDENCE_ORDER } = await import(pathToFileURL(join(ws, 'src/pipeline/precedence-resolver.js')).href);

  assert.deepEqual([...PRECEDENCE_ORDER], ['cli', 'env', 'workspace', 'defaults']);
  const pollutedInput = JSON.parse('{"__proto__":{"polluted":true},"nested":{"__proto__":{"x":1},"Sub-Key":0}}');
  const norm = normalizeConfigLayer(pollutedInput);
  assert.equal(({}).polluted, undefined);
  assert.equal(({}).x, undefined);
  assert.equal(norm.nested.sub_key, 0);

  const a = runContractPipeline({
    defaults: { timeout_ms: 1000, retry_limit: 1 },
    cli: { strict_mode: false, max_concurrency: 4 },
  });
  const b = runContractPipeline({
    defaults: { retry_limit: 1, timeout_ms: 1000 },
    cli: { max_concurrency: 4, strict_mode: false },
  });
  assert.equal(a.checksum, b.checksum);
  assert.match(a.checksum, /^[0-9a-f]{64}$/);
});

test('hidden acceptance: loader calls normalizer and avoids legacy/plugin decoys', () => {
  const loaderSrc = readFileSync(join(ws, 'src/pipeline/loader.js'), 'utf8');
  assert.match(loaderSrc, /normalizer\\.js/);
  assert.equal(/legacy-v0-evaluator|plugins\\//.test(loaderSrc), false);
});
`,
    }),
    metadata: buildTaskMetadata({
      id: 'aci-03-contract-pipeline-refactor',
      area: 'contract_pipeline_refactor',
      requiredChangedFiles: [
        'src/pipeline/loader.js',
        'src/pipeline/normalizer.js',
        'src/pipeline/precedence-resolver.js',
        'src/pipeline/evaluator.js',
      ],
      testFiles: ['test/pipeline-baseline.test.js'],
      testCommand: ['node', '--test', 'test/pipeline-baseline.test.js'],
      repoFileCount: 17,
      groundTruth: {
        criticalFiles: [
          'CONTRACT.json',
          'src/pipeline/loader.js',
          'src/pipeline/normalizer.js',
          'src/pipeline/precedence-resolver.js',
          'src/pipeline/evaluator.js',
          'src/pipeline/schema-validator.js',
        ],
        relevantFiles: [
          'package.json',
          'README.md',
          'CONTRACT.json',
          'src/index.js',
          'src/pipeline/schema-validator.js',
          'src/pipeline/loader.js',
          'src/pipeline/normalizer.js',
          'src/pipeline/precedence-resolver.js',
          'src/pipeline/evaluator.js',
          'test/pipeline-baseline.test.js',
        ],
        noiseFiles: [
          'plugins/slack-adapter.js',
          'plugins/prometheus-exporter.js',
          'plugins/s3-archiver.js',
          'plugins/email-notifier.js',
          'fixtures/sample-configs.json',
          'docs/CHANGELOG.md',
          'src/pipeline/legacy-v0-evaluator.js',
        ],
      },
    }),
  },

  // 4) aci-04-long-horizon-security-audit
  {
    id: 'aci-04-long-horizon-security-audit',
    area: 'long_horizon_security_audit',
    title: 'Multi-Stage Security Path-Guard, Policy Engine, Audit Chain & Digest Report',
    objective: 'Fix symlink/dotdot/encoded path bypasses, default-deny policy enforcement, tamper-evident audit hash chaining, and SHA-256 verified AUDIT_REPORT.json generation.',
    prompt: [
      'Implement all 4 security & audit stages specified in `SPEC.md`:',
      '1. `src/security/path-guard.js`: `confineAuditPath(rootDir, candidatePath)` blocking empty/NUL/`..`/encoded `%2e`/`%2f`/`%5c`/double-encoded/drive/leading-slash escapes AND resolving symlinks inside `rootDir` safely via `realpathSync` + `lstatSync`.',
      '2. `src/security/policy-engine.js`: `evaluateAccessPolicy({ actor, role, action, rootDir, targetPath, auditStore })` invoking `confineAuditPath` without swallowing exceptions into allow, enforcing default-deny against `ROLE_POLICIES`, and appending every evaluation to `auditStore`.',
      '3. `src/persistence/audit-store.js`: `AuditStore` chaining `prevHash -> entryHash` from `GENESIS_HASH` (`"0".repeat(64)`) and `verifyAuditChain(entries)` checking sequential integrity and SHA-256 digests.',
      '4. `src/cli/audit-export.js`: CLI (`--input`, `--root`, `--out`) generating `AUDIT_REPORT.json` with `schemaVersion: "1.0.0"`, `chainValid`, `eventCount`, `chainHeadHash`, sorted `artifactDigests`, and `rootDigestSha256`.',
      'Generate `AUDIT_REPORT.json` in the workspace root by running `node src/cli/audit-export.js --input fixtures/baseline-events.json --root . --out AUDIT_REPORT.json`.',
      'Do NOT modify `SPEC.md`, `fixtures/baseline-events.json`, or `test/audit-baseline.test.js`. Run `node --test test/audit-baseline.test.js`.',
    ].join('\n'),
    fixture: {
      files: {
        'package.json': JSON.stringify({ name: 'aci-04-sec-audit', version: '1.0.0', type: 'module' }, null, 2) + '\n',
        'README.md': '# Security & Audit Pipeline\nSee `SPEC.md` and `src/cli/audit-export.js`.\n',
        'SPEC.md': ACI_04_SPEC,
        'src/index.js': "export { confineAuditPath } from './security/path-guard.js';\nexport { ROLE_POLICIES, evaluateAccessPolicy } from './security/policy-engine.js';\nexport { GENESIS_HASH, AuditStore, verifyAuditChain } from './persistence/audit-store.js';\n",
        'src/security/path-guard.js': [
          "import { join, resolve } from 'node:path';",
          'export function confineAuditPath(rootDir, candidatePath) {',
          '  const raw = String(candidatePath ?? "");',
          '  if (!raw || raw.includes("..")) throw new Error("Unsafe path");',
          '  return join(resolve(rootDir), raw);',
          '}',
        ].join('\n') + '\n',
        'src/security/policy-engine.js':
          ACI_04_POLICY_ENGINE_HEADER +
          [
            'export function evaluateAccessPolicy({ actor = "anonymous", role = "", action = "", rootDir = process.cwd(), targetPath = "", auditStore = null } = {}) {',
            '  let resolved = targetPath;',
            '  try {',
            '    resolved = confineAuditPath(rootDir, targetPath);',
            '  } catch {',
            '    return { allowed: true, reason: "FALLBACK_ALLOW", resource: targetPath };',
            '  }',
            '  const allowedList = ROLE_POLICIES[role] || [];',
            '  const allowed = allowedList.length === 0 ? true : allowedList.includes(action);',
            '  const decision = { allowed, reason: allowed ? "ALLOWED" : "POLICY_DENIED", resource: resolved };',
            '  if (auditStore) auditStore.append({ actor, action, resource: resolved, allowed: decision.allowed, reason: decision.reason });',
            '  return decision;',
            '}',
          ].join('\n') + '\n',
        'src/persistence/audit-store.js': [
          "import { createHash } from 'node:crypto';",
          'export const GENESIS_HASH = "0".repeat(64);',
          'export class AuditStore {',
          '  #entries = [];',
          '  append({ actor, action, resource, allowed, reason }) {',
          '    const seq = this.#entries.length + 1;',
          '    const entryHash = createHash("sha256").update(JSON.stringify({ seq, actor, action, resource, allowed, reason })).digest("hex");',
          '    const rec = { seq, prevHash: GENESIS_HASH, actor, action, resource, allowed: Boolean(allowed), reason: String(reason || ""), entryHash };',
          '    this.#entries.push(rec);',
          '    return rec;',
          '  }',
          '  entries() { return [...this.#entries]; }',
          '  headHash() { return this.#entries.at(-1)?.entryHash ?? GENESIS_HASH; }',
          '  verifyChain() { return true; }',
          '}',
          'export function verifyAuditChain(entries = []) { return Array.isArray(entries); }',
        ].join('\n') + '\n',
        'src/cli/audit-export.js': [
          '#!/usr/bin/env node',
          "import { writeFileSync } from 'node:fs';",
          'writeFileSync("AUDIT_REPORT.json", JSON.stringify({ schemaVersion: "1.0.0", entries: [] }, null, 2) + "\\n", "utf8");',
        ].join('\n') + '\n',
        'fixtures/baseline-events.json': ACI_04_BASELINE_EVENTS,
        'test/audit-baseline.test.js': [
          "import test from 'node:test';",
          "import assert from 'node:assert/strict';",
          "import { resolve } from 'node:path';",
          "import { confineAuditPath, AuditStore } from '../src/index.js';",
          "test('baseline path guard and audit store work on safe relative path', () => {",
          '  const root = resolve(process.cwd());',
          '  const out = confineAuditPath(root, "fixtures/baseline-events.json");',
          '  assert.ok(out.startsWith(root));',
          '  const store = new AuditStore();',
          '  const rec = store.append({ actor: "alice", action: "audit:read", resource: "fixtures/baseline-events.json", allowed: true, reason: "ALLOWED" });',
          '  assert.equal(rec.seq, 1);',
          '});',
        ].join('\n') + '\n',
        'fixtures/raw-audit-traces.jsonl': buildCsvDecoy({
          headerCols: ['seq', 'ts', 'actor', 'action', 'path', 'sha256', 'allowed', 'note'],
          keywords: ['audit', 'policy', 'path-guard', 'sha256'],
          rows: 95,
        }),
        'src/legacy/v0-policy-rules.js': buildLegacyJsDecoy({
          moduleLabel: 'v0-policy-rules',
          domainKeywords: ['evaluateAccessPolicy', 'ROLE_POLICIES', 'path-guard', 'audit'],
          exportsList: ['evaluateV0Policy', 'allowFallbackPolicy'],
        }),
        'src/legacy/v0-path-normalizer.js': buildLegacyJsDecoy({
          moduleLabel: 'v0-path-normalizer',
          domainKeywords: ['confineAuditPath', 'traversal', 'symlink', 'audit'],
          exportsList: ['normalizeLegacyAuditPath'],
        }),
        'docs/COMPLIANCE-APPENDIX.md': buildMarkdownArchiveDecoy({
          title: 'Compliance Appendix',
          keywords: ['audit-store', 'path-guard', 'policy-engine', 'sha256'],
          sections: 20,
        }),
        'templates/audit-report.html': buildHtmlTemplateDecoy({
          title: 'Audit Report Template',
          keywords: ['audit', 'digest', 'chainHeadHash', 'policy'],
        }),
        'docs/CHANGELOG.md': buildChangelogDecoy({
          title: 'Security & Audit CLI',
          keywords: ['path-guard', 'policy-engine', 'audit-store', 'audit-export'],
        }),
        'fixtures/sample-security-events.json': buildJsonFixtureDecoy({
          title: 'Sample Security Events',
          keywords: ['audit', 'policy', 'path', 'sha256'],
        }),
      },
      baselineTestFiles: ['test/audit-baseline.test.js'],
      baselineTestCommand: ['node', '--test', 'test/audit-baseline.test.js'],
    },
    judge: makeAciGovernanceJudge({
      requiredSourceFiles: [
        'src/security/path-guard.js',
        'src/security/policy-engine.js',
        'src/persistence/audit-store.js',
        'src/cli/audit-export.js',
        'AUDIT_REPORT.json',
      ],
      protectedReadOnlyFiles: [
        'SPEC.md',
        'fixtures/baseline-events.json',
        'test/audit-baseline.test.js',
      ],
      rootCauseFiles: [
        'src/security/path-guard.js',
        'src/security/policy-engine.js',
        'src/persistence/audit-store.js',
        'src/cli/audit-export.js',
      ],
      extraCheck: ({ workspaceRoot }) => {
        const report = readWorkspaceJson(workspaceRoot, 'AUDIT_REPORT.json');
        const tracked = [
          'src/cli/audit-export.js',
          'src/persistence/audit-store.js',
          'src/security/path-guard.js',
          'src/security/policy-engine.js',
        ].sort();
        if (!report || report.chainValid !== true || !Array.isArray(report.artifactDigests)) {
          return { auditReportDigestValid: false };
        }
        const expectedDigests = tracked.map((p) => ({
          path: p,
          sha256: sha256Text(readWorkspaceText(workspaceRoot, p) ?? ''),
        }));
        const digestsMatch =
          report.artifactDigests.length === expectedDigests.length &&
          expectedDigests.every(
            (d, i) => report.artifactDigests[i]?.path === d.path && report.artifactDigests[i]?.sha256 === d.sha256,
          );
        const expectedRoot = sha256Text(
          canonicalJson({
            artifactDigests: expectedDigests,
            chainHeadHash: report.chainHeadHash,
            chainValid: report.chainValid,
          }),
        );
        return {
          auditReportDigestValid: digestsMatch && report.rootDigestSha256 === expectedRoot,
        };
      },
      hiddenAcceptanceScript: `
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ws = process.env.WORKSPACE_ROOT || process.env.AGENT_US_EVAL_WORKSPACE;

function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
}

test('hidden acceptance: path-guard blocks encoded, dotdot, NUL, drive, and symlink escapes', async () => {
  const { confineAuditPath } = await import(pathToFileURL(join(ws, 'src/security/path-guard.js')).href);
  const base = mkdtempSync(join(tmpdir(), 'aci04-pg-'));
  const root = join(base, 'root');
  const outside = join(base, 'outside');
  mkdirSync(join(root, 'sub'), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(root, 'sub', 'ok.json'), '{}');
  writeFileSync(join(outside, 'secret.txt'), 'secret');
  let symlinkCreated = false;
  try {
    symlinkSync(outside, join(root, 'escape-link'), process.platform === 'win32' ? 'junction' : 'dir');
    symlinkCreated = true;
  } catch (err) {
    if (!(err?.code === 'ERR_ACCESS_DENIED' && process.permission && !process.permission.has('fs.write', '*'))) {
      throw err;
    }
  }
  try {
    assert.ok(confineAuditPath(root, 'sub/ok.json').endsWith('ok.json'));
    const attacks = [
      '',
      '../outside/secret.txt',
      '..\\\\outside\\\\secret.txt',
      '/etc/passwd',
      'C:\\\\Windows\\\\System32',
      'sub/%2e%2e/%2e%2e/outside/secret.txt',
      'sub/%252e%252e/outside/secret.txt',
      'sub/ok.json\\0.txt',
      'sub/ok.json%00.txt',
      ...(symlinkCreated ? ['escape-link/secret.txt'] : []),
    ];
    for (const bad of attacks) {
      assert.throws(() => confineAuditPath(root, bad), Error, 'Expected path-guard rejection for: ' + bad);
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('hidden acceptance: policy-engine enforces default-deny and audit-store verifies SHA-256 chain', async () => {
  const { evaluateAccessPolicy, AuditStore, verifyAuditChain } = await import(pathToFileURL(join(ws, 'src/index.js')).href);
  const store = new AuditStore();
  const okRes = evaluateAccessPolicy({
    actor: 'alice',
    role: 'auditor',
    action: 'audit:read',
    rootDir: ws,
    targetPath: 'fixtures/baseline-events.json',
    auditStore: store,
  });
  assert.equal(okRes.allowed, true);

  const deniedAction = evaluateAccessPolicy({
    actor: 'alice',
    role: 'auditor',
    action: 'policy:write',
    rootDir: ws,
    targetPath: 'fixtures/baseline-events.json',
    auditStore: store,
  });
  assert.equal(deniedAction.allowed, false);

  const deniedRole = evaluateAccessPolicy({
    actor: 'eve',
    role: 'guest',
    action: 'audit:read',
    rootDir: ws,
    targetPath: 'fixtures/baseline-events.json',
    auditStore: store,
  });
  assert.equal(deniedRole.allowed, false);

  const deniedPath = evaluateAccessPolicy({
    actor: 'mallory',
    role: 'security_admin',
    action: 'audit:read',
    rootDir: ws,
    targetPath: 'sub/%2e%2e/%2e%2e/etc/passwd',
    auditStore: store,
  });
  assert.equal(deniedPath.allowed, false);

  assert.equal(store.verifyChain(), true);
  const entries = store.entries();
  assert.equal(entries.length, 4);
  assert.equal(entries[1].prevHash, entries[0].entryHash);
  assert.equal(verifyAuditChain(entries), true);

  const tampered = entries.map((e, i) => (i === 1 ? { ...e, allowed: true } : e));
  assert.equal(verifyAuditChain(tampered), false);
});

test('hidden acceptance: AUDIT_REPORT.json and audit-export CLI produce matching SHA-256 digests', () => {
  const report = JSON.parse(readFileSync(join(ws, 'AUDIT_REPORT.json'), 'utf8'));
  assert.equal(report.schemaVersion, '1.0.0');
  assert.equal(report.chainValid, true);
  assert.equal(report.eventCount, 3);
  const expectedFiles = [
    'src/cli/audit-export.js',
    'src/persistence/audit-store.js',
    'src/security/path-guard.js',
    'src/security/policy-engine.js',
  ].sort();
  assert.deepEqual(report.artifactDigests.map((d) => d.path), expectedFiles);
  for (const d of report.artifactDigests) {
    const actualSha = createHash('sha256').update(readFileSync(join(ws, d.path))).digest('hex');
    assert.equal(d.sha256, actualSha);
  }
  const expectedRoot = createHash('sha256')
    .update(canonical({ artifactDigests: report.artifactDigests, chainHeadHash: report.chainHeadHash, chainValid: report.chainValid }))
    .digest('hex');
  assert.equal(report.rootDigestSha256, expectedRoot);

  const tmp = mkdtempSync(join(tmpdir(), 'aci04-cli-'));
  try {
    const outPath = join(tmp, 'out-report.json');
    const cli = spawnSync(
      process.execPath,
      [join(ws, 'src/cli/audit-export.js'), '--input', join(ws, 'fixtures/baseline-events.json'), '--root', ws, '--out', outPath],
      { encoding: 'utf8' },
    );
    assert.equal(cli.status, 0, cli.stderr);
    const cliReport = JSON.parse(readFileSync(outPath, 'utf8'));
    assert.equal(cliReport.rootDigestSha256, report.rootDigestSha256);
    assert.equal(cliReport.chainValid, true);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
`,
    }),
    metadata: buildTaskMetadata({
      id: 'aci-04-long-horizon-security-audit',
      area: 'long_horizon_security_audit',
      requiredChangedFiles: [
        'src/security/path-guard.js',
        'src/security/policy-engine.js',
        'src/persistence/audit-store.js',
        'src/cli/audit-export.js',
        'AUDIT_REPORT.json',
      ],
      testFiles: ['test/audit-baseline.test.js'],
      testCommand: ['node', '--test', 'test/audit-baseline.test.js'],
      repoFileCount: 17,
      allowWorkspaceNodeCli: true,
      groundTruth: {
        criticalFiles: [
          'SPEC.md',
          'src/security/path-guard.js',
          'src/security/policy-engine.js',
          'src/persistence/audit-store.js',
          'src/cli/audit-export.js',
          'fixtures/baseline-events.json',
        ],
        relevantFiles: [
          'package.json',
          'README.md',
          'SPEC.md',
          'src/index.js',
          'src/security/path-guard.js',
          'src/security/policy-engine.js',
          'src/persistence/audit-store.js',
          'src/cli/audit-export.js',
          'fixtures/baseline-events.json',
          'test/audit-baseline.test.js',
        ],
        noiseFiles: [
          'fixtures/raw-audit-traces.jsonl',
          'src/legacy/v0-policy-rules.js',
          'src/legacy/v0-path-normalizer.js',
          'docs/COMPLIANCE-APPENDIX.md',
          'templates/audit-report.html',
          'docs/CHANGELOG.md',
          'fixtures/sample-security-events.json',
        ],
      },
    }),
  },
];

function finalizeRawAciTask(raw, { is25 = false, is26 = false } = {}) {
  const baselineFileHashes = computeFileHashes(raw.fixture.files, [
    ...(raw.fixture.baselineTestFiles ?? []),
    ...Object.keys(raw.fixture.files).filter((p) =>
      ['SPEC.md', 'CONSTRAINTS.md', 'CONTRACT.json', 'fixtures/baseline-events.json'].includes(p) ||
      p === 'src/core/runtime-options.js' ||
      p === 'src/core/diagnostic-codes.js' ||
      p === 'src/core/evolution-codes.js' ||
      p === 'src/reporting/audit-summary.js' ||
      p === 'src/index.js' ||
      p === 'src/auth/token-verifier.js' ||
      p === 'src/api/auth-routes.js' ||
      p === 'src/persistence/crc32.js' ||
      p === 'src/api/ledger-contract.js' ||
      p === 'src/pipeline/schema-validator.js',
    ),
  ]);
  const repoFileCount = Object.keys(raw.fixture.files).length;
  const totalWorkspaceTokens = Object.values(raw.fixture.files).reduce(
    (sum, content) => sum + estimateTokens(content),
    0,
  );
  const budgetPlan = estimateTaskBudget({
    taskType: raw.id,
    fileCount: repoFileCount,
    requiredTools: ['read_file', 'write_file', 'edit_file', 'bash'],
    expectedArtifacts: raw.metadata.expectedArtifacts,
    verificationComplexity: 'high',
    recoveryRequirements: true,
  });
  const minBudgetTokens =
    raw.id === 'aci-06-swarm-contract-integration'
      ? 240_000
      : raw.id === 'aci-04-long-horizon-security-audit' || raw.id === 'aci-07-cross-module-evolution'
        ? 220_000
        : raw.id === 'aci-05-multi-module-patch-refactor'
          ? 180_000
          : 160_000;
  const maxBudgetTokens = Math.max(minBudgetTokens, budgetPlan.estimatedTokens);
  const resourceBudget = {
    maxSteps: Math.max(22, budgetPlan.maxSteps),
    maxTokens: maxBudgetTokens,
    maxTotalTokens: maxBudgetTokens,
    finalVerificationReserve: budgetPlan.finalVerificationReserve,
    maxDurationMs: Math.max(90_000, budgetPlan.maxSteps * 5_000),
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
    category: is26 ? 'aci-governance-2.6' : is25 ? 'aci-governance-2.5' : 'aci-governance-2.4-s4',
    difficulty: 'hard',
    tags: is26
      ? ['benchmark', 'aci-governance', '2.6', raw.area]
      : is25
        ? ['benchmark', 'aci-governance', '2.5', raw.area]
        : ['benchmark', 'aci-governance', '2.4', 'stage-4', raw.area],
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
      repoFileCount,
      totalWorkspaceTokens,
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
}

const RAW_ACI_TASKS = RAW_ACI_BASE_TASKS.map((raw) => finalizeRawAciTask(raw, { is25: false }));

const RAW_ACI_25_ONLY_TASKS = [
  // 5) aci-05-multi-module-patch-refactor
  {
    id: 'aci-05-multi-module-patch-refactor',
    area: 'multi_module_patch_refactor',
    title: 'Multi-Module Patch Conflict Guard & Structured Diagnostic Pipeline Refactor',
    objective: 'Fix ANSI/compiler diagnostic parsing, severity-ranked deduplication, atomic optimistic-lock patch validation, and deterministic report digests across 4 pipeline modules.',
    prompt: [
      'Inspect `SPEC.md`, `CONSTRAINTS.md`, `src/core/diagnostic-codes.js`, and `src/index.js`.',
      'Repair the multi-module patch validation & diagnostic compression pipeline ONLY in:',
      '1. `src/diagnostics/parser.js`: strip ANSI color escapes, normalize `\\\\` to `/`, parse both `file(line,col): severity code: msg` and `file:line(:col)?: severity (code:)?: msg`, normalize severity (`error|warning|info`), and emit fallback info entries for unparsed non-empty lines.',
      '2. `src/diagnostics/deduplicator.js`: deduplicate by `(normFile, line, code, message)` tracking `occurrenceCount` and `firstSeenLine`, sort by `SEVERITY_ORDER` then file/line/message, slice to `maxItems`, and return `{ items, compression: { totalRaw, uniqueCount, keptCount, truncatedCount } }`.',
      '3. `src/patch/conflict-guard.js`: confine relative paths (reject empty, `/`, `..`, `C:`, `.git`), enforce all-or-nothing preflight `OPTIMISTIC_LOCK_CONFLICT` when any hunk `expectedSha256` mismatches `fileContents`, and compute `{ path, additions, deletions, sha256After }` summaries.',
      '4. `src/pipeline/report-builder.js`: wire `validatePatchBatch`, `parseDiagnosticLines`, and `deduplicateDiagnostics` to emit `{ ok, patch, diagnostics, reportDigest }` with canonical SHA-256 `reportDigest`.',
      'Leave `src/core/diagnostic-codes.js`, `SPEC.md`, `CONSTRAINTS.md`, and `test/patch-diagnostics-baseline.test.js` unmodified.',
      'Run `node --test test/patch-diagnostics-baseline.test.js` after editing.',
    ].join('\n'),
    fixture: {
      files: {
        'package.json': JSON.stringify({ name: 'aci-05-patch-diagnostics', version: '1.0.0', type: 'module' }, null, 2) + '\n',
        'README.md': '# Patch & Diagnostics Pipeline\nEntrypoint: `src/index.js`. Governed by `SPEC.md` and `CONSTRAINTS.md`.\n',
        'SPEC.md': ACI_05_SPEC,
        'CONSTRAINTS.md': ACI_05_CONSTRAINTS,
        'src/index.js': [
          "export { PATCH_DIAGNOSTIC_CODES, SEVERITY_ORDER, sha256Hex, canonicalStringify } from './core/diagnostic-codes.js';",
          "export { parseDiagnosticLines } from './diagnostics/parser.js';",
          "export { deduplicateDiagnostics } from './diagnostics/deduplicator.js';",
          "export { validatePatchBatch } from './patch/conflict-guard.js';",
          "export { buildPatchDiagnosticsReport } from './pipeline/report-builder.js';",
        ].join('\n') + '\n',
        'src/core/diagnostic-codes.js': ACI_05_CODES_MODULE,
        'src/diagnostics/parser.js': [
          'export function parseDiagnosticLines(rawText = "") {',
          '  const lines = String(rawText || "").split(/\\r?\\n/).map((l) => l.trim()).filter(Boolean);',
          '  const out = [];',
          '  for (const line of lines) {',
          '    const m = /^([^:]+):(\\d+):\\s*(.+)$/.exec(line);',
          '    if (m) {',
          '      out.push({ file: m[1], line: Number(m[2]), column: null, severity: "error", code: null, message: m[3] });',
          '    }',
          '  }',
          '  return out;',
          '}',
        ].join('\n') + '\n',
        'src/diagnostics/deduplicator.js': [
          'export function deduplicateDiagnostics(entries = [], { maxItems = 50 } = {}) {',
          '  const list = Array.isArray(entries) ? entries : [];',
          '  const unique = [];',
          '  const seen = new Set();',
          '  for (const e of list) {',
          '    const key = JSON.stringify(e);',
          '    if (seen.has(key)) continue;',
          '    seen.add(key);',
          '    unique.push({ ...e, occurrenceCount: 1, firstSeenLine: e.line ?? null });',
          '  }',
          '  const items = unique.slice(0, maxItems);',
          '  return { items, compression: { totalRaw: list.length, uniqueCount: unique.length, keptCount: items.length, truncatedCount: 0 } };',
          '}',
        ].join('\n') + '\n',
        'src/patch/conflict-guard.js': [
          "import { PATCH_DIAGNOSTIC_CODES, sha256Hex } from '../core/diagnostic-codes.js';",
          'export function validatePatchBatch(hunks = [], fileContents = {}) {',
          '  const appliedFiles = { ...fileContents };',
          '  const fileSummaries = [];',
          '  for (const h of Array.isArray(hunks) ? hunks : []) {',
          '    appliedFiles[h.path] = h.after ?? "";',
          '    fileSummaries.push({ path: h.path, additions: 1, deletions: 0, sha256After: sha256Hex(h.after ?? "") });',
          '  }',
          '  return { ok: true, code: PATCH_DIAGNOSTIC_CODES.OK, conflicts: [], appliedFiles, fileSummaries };',
          '}',
        ].join('\n') + '\n',
        'src/pipeline/report-builder.js': [
          "import { sha256Hex } from '../core/diagnostic-codes.js';",
          "import { parseDiagnosticLines } from '../diagnostics/parser.js';",
          "import { deduplicateDiagnostics } from '../diagnostics/deduplicator.js';",
          "import { validatePatchBatch } from '../patch/conflict-guard.js';",
          'export function buildPatchDiagnosticsReport({ hunks = [], fileContents = {}, rawDiagnostics = "", maxItems = 50 } = {}) {',
          '  const patch = validatePatchBatch(hunks, fileContents);',
          '  const parsed = parseDiagnosticLines(rawDiagnostics);',
          '  const diagnostics = deduplicateDiagnostics(parsed, { maxItems });',
          '  return { ok: true, patch, diagnostics, reportDigest: sha256Hex(JSON.stringify({ patch, diagnostics })) };',
          '}',
        ].join('\n') + '\n',
        'test/patch-diagnostics-baseline.test.js': [
          "import test from 'node:test';",
          "import assert from 'node:assert/strict';",
          "import { buildPatchDiagnosticsReport } from '../src/index.js';",
          "test('baseline patch diagnostics pipeline handles basic single-file colon diagnostic', () => {",
          '  const res = buildPatchDiagnosticsReport({',
          '    hunks: [{ path: "src/app.js", after: "export const x = 1;\\n" }],',
          '    fileContents: { "src/app.js": "export const x = 0;\\n" },',
          '    rawDiagnostics: "src/app.js:1: sample diagnostic",',
          '  });',
          '  assert.equal(res.patch.ok, true);',
          '  assert.equal(res.diagnostics.items.length, 1);',
          '});',
        ].join('\n') + '\n',
        'src/legacy/v1-regex-linter.js': buildLegacyJsDecoy({
          moduleLabel: 'v1-regex-linter',
          domainKeywords: ['parseDiagnosticLines', 'deduplicateDiagnostics', 'severity', 'ANSI'],
          exportsList: ['runLegacyRegexLinter', 'formatV1LintOutput'],
        }),
        'src/legacy/v1-patch-shim.js': buildLegacyJsDecoy({
          moduleLabel: 'v1-patch-shim',
          domainKeywords: ['validatePatchBatch', 'expectedSha256', 'OPTIMISTIC_LOCK_CONFLICT', 'hunks'],
          exportsList: ['applyV1PatchShim', 'verifyLegacyPatchLock'],
        }),
        'src/telemetry/diagnostic-sampler.js': buildLegacyJsDecoy({
          moduleLabel: 'diagnostic-sampler',
          domainKeywords: ['reportDigest', 'truncatedCount', 'diagnostics', 'sampler'],
          exportsList: ['sampleDiagnosticTelemetry', 'emitDiagnosticMetric'],
        }),
        'docs/CHANGELOG.md': buildChangelogDecoy({
          title: 'Multi-Module Patch & Diagnostics',
          keywords: ['parser', 'deduplicator', 'conflict-guard', 'report-builder'],
        }),
        'docs/HISTORICAL-DIAGNOSTICS.md': buildMarkdownArchiveDecoy({
          title: 'Historical Diagnostic Formats',
          keywords: ['TS2345', 'OPTIMISTIC_LOCK_CONFLICT', 'deduplicator', 'patch'],
          sections: 20,
        }),
        'fixtures/sample-tsc-output.json': buildJsonFixtureDecoy({
          title: 'Sample Compiler Diagnostic Records',
          keywords: ['diagnostics', 'severity', 'hunk', 'sha256After'],
        }),
        'fixtures/historical-lint-traces.csv': buildCsvDecoy({
          headerCols: ['seq', 'ts', 'stage', 'kind', 'tenant', 'digest', 'status', 'note'],
          keywords: ['parser', 'dedup', 'patch', 'report'],
          rows: 92,
        }),
        'templates/patch-report.html': buildHtmlTemplateDecoy({
          title: 'Patch Diagnostics Archive Template',
          keywords: ['patch', 'diagnostic', 'reportDigest', 'conflict'],
        }),
      },
      baselineTestFiles: ['test/patch-diagnostics-baseline.test.js'],
      baselineTestCommand: ['node', '--test', 'test/patch-diagnostics-baseline.test.js'],
    },
    judge: makeAciGovernanceJudge({
      requiredSourceFiles: [
        'src/diagnostics/parser.js',
        'src/diagnostics/deduplicator.js',
        'src/patch/conflict-guard.js',
        'src/pipeline/report-builder.js',
      ],
      protectedReadOnlyFiles: [
        'SPEC.md',
        'CONSTRAINTS.md',
        'src/core/diagnostic-codes.js',
        'test/patch-diagnostics-baseline.test.js',
      ],
      rootCauseFiles: [
        'src/diagnostics/parser.js',
        'src/diagnostics/deduplicator.js',
        'src/patch/conflict-guard.js',
        'src/pipeline/report-builder.js',
      ],
      extraCheck: ({ workspaceRoot }) => {
        const pkg = readWorkspaceJson(workspaceRoot, 'package.json');
        const parserSrc = readWorkspaceText(workspaceRoot, 'src/diagnostics/parser.js') ?? '';
        const dedupSrc = readWorkspaceText(workspaceRoot, 'src/diagnostics/deduplicator.js') ?? '';
        const guardSrc = readWorkspaceText(workspaceRoot, 'src/patch/conflict-guard.js') ?? '';
        const builderSrc = readWorkspaceText(workspaceRoot, 'src/pipeline/report-builder.js') ?? '';
        const c1 = !pkg?.dependencies || Object.keys(pkg.dependencies).length === 0;
        const c2 =
          /export\s+function\s+parseDiagnosticLines/.test(parserSrc) &&
          /export\s+function\s+deduplicateDiagnostics/.test(dedupSrc) &&
          /export\s+function\s+validatePatchBatch/.test(guardSrc) &&
          /export\s+function\s+buildPatchDiagnosticsReport/.test(builderSrc);
        return { constraintsPreserved: c1 && c2 };
      },
      hiddenAcceptanceScript: `
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ws = process.env.WORKSPACE_ROOT || process.env.AGENT_US_EVAL_WORKSPACE;

test('hidden acceptance: ANSI/Windows/TSC parser and severity-ranked deduplication with truncation stats', async () => {
  const { parseDiagnosticLines, deduplicateDiagnostics } = await import(pathToFileURL(join(ws, 'src/index.js')).href);
  const raw = [
    '',
    '\\x1b[31msrc\\\\b.js(14,3): error TS2345: Type mismatch\\x1b[0m',
    'src/b.js:14:3: error TS2345: Type mismatch',
    'src\\\\a.js:4:2: warn W100: Unused variable',
    'src/a.js:4:2: warn W100: Unused variable',
    'src/z.js:9: info: Check complete',
    'unstructured diagnostic note',
  ].join('\\n');

  const parsed = parseDiagnosticLines(raw);
  assert.equal(parsed.length, 6);
  assert.equal(parsed[0].file, 'src/b.js');
  assert.equal(parsed[0].line, 14);
  assert.equal(parsed[0].column, 3);
  assert.equal(parsed[0].severity, 'error');
  assert.equal(parsed[0].code, 'TS2345');
  assert.equal(parsed[2].severity, 'warning');
  assert.equal(parsed[5].file, null);
  assert.equal(parsed[5].severity, 'info');

  const dedup = deduplicateDiagnostics(parsed, { maxItems: 3 });
  assert.equal(dedup.compression.totalRaw, 6);
  assert.equal(dedup.compression.uniqueCount, 4);
  assert.equal(dedup.compression.keptCount, 3);
  assert.equal(dedup.compression.truncatedCount, 1);
  assert.equal(dedup.items[0].severity, 'error');
  assert.equal(dedup.items[0].occurrenceCount, 2);
  assert.equal(dedup.items[1].severity, 'warning');
  assert.equal(dedup.items[1].occurrenceCount, 2);
});

test('hidden acceptance: validatePatchBatch enforces path confinement and atomic OPTIMISTIC_LOCK_CONFLICT', async () => {
  const { validatePatchBatch, PATCH_DIAGNOSTIC_CODES } = await import(pathToFileURL(join(ws, 'src/index.js')).href);
  const baseA = 'line1\\nline2\\n';
  const baseB = 'alpha\\nbeta\\n';
  const shaA = createHash('sha256').update(baseA).digest('hex');

  const conflictRes = validatePatchBatch(
    [
      { path: 'src/a.js', after: 'line1\\nchanged\\n', expectedSha256: shaA },
      { path: 'src/b.js', after: 'gamma\\n', expectedSha256: 'deadbeef' },
    ],
    { 'src/a.js': baseA, 'src/b.js': baseB },
  );
  assert.equal(conflictRes.ok, false);
  assert.equal(conflictRes.code, PATCH_DIAGNOSTIC_CODES.OPTIMISTIC_LOCK_CONFLICT);
  assert.deepEqual(conflictRes.appliedFiles, {});
  assert.equal(conflictRes.conflicts.length, 1);
  assert.equal(conflictRes.conflicts[0].path, 'src/b.js');

  const escapeRes = validatePatchBatch(
    [{ path: '../escape.js', after: 'bad' }],
    {},
  );
  assert.equal(escapeRes.ok, false);
  assert.equal(escapeRes.code, PATCH_DIAGNOSTIC_CODES.PATH_CONFINEMENT_ERROR);
});

test('hidden acceptance: buildPatchDiagnosticsReport computes deterministic canonical digest and status', async () => {
  const { buildPatchDiagnosticsReport } = await import(pathToFileURL(join(ws, 'src/index.js')).href);
  const base = 'const a = 1;\\nconst b = 2;\\n';
  const sha = createHash('sha256').update(base).digest('hex');
  const clean = buildPatchDiagnosticsReport({
    hunks: [{ path: 'src/mod.js', after: 'const a = 1;\\nconst b = 3;\\nconst c = 4;\\n', expectedSha256: sha }],
    fileContents: { 'src/mod.js': base },
    rawDiagnostics: 'src/mod.js:2: warning W001: check value',
    maxItems: 10,
  });
  assert.equal(clean.ok, true);
  assert.equal(clean.patch.fileSummaries[0].additions >= 2, true);
  assert.equal(clean.patch.fileSummaries[0].deletions >= 1, true);
  assert.match(clean.reportDigest, /^[0-9a-f]{64}$/);

  const withErr = buildPatchDiagnosticsReport({
    hunks: [{ path: 'src/mod.js', after: 'const a = 1;\\n', expectedSha256: sha }],
    fileContents: { 'src/mod.js': base },
    rawDiagnostics: 'src/mod.js(1,1): error TS1005: syntax',
  });
  assert.equal(withErr.ok, false);
});
`,
    }),
    metadata: buildTaskMetadata({
      id: 'aci-05-multi-module-patch-refactor',
      area: 'multi_module_patch_refactor',
      requiredChangedFiles: [
        'src/diagnostics/parser.js',
        'src/diagnostics/deduplicator.js',
        'src/patch/conflict-guard.js',
        'src/pipeline/report-builder.js',
      ],
      testFiles: ['test/patch-diagnostics-baseline.test.js'],
      testCommand: ['node', '--test', 'test/patch-diagnostics-baseline.test.js'],
      repoFileCount: 19,
      groundTruth: {
        criticalFiles: [
          'SPEC.md',
          'CONSTRAINTS.md',
          'src/core/diagnostic-codes.js',
          'src/diagnostics/parser.js',
          'src/diagnostics/deduplicator.js',
          'src/patch/conflict-guard.js',
          'src/pipeline/report-builder.js',
        ],
        relevantFiles: [
          'package.json',
          'README.md',
          'SPEC.md',
          'CONSTRAINTS.md',
          'src/index.js',
          'src/core/diagnostic-codes.js',
          'src/diagnostics/parser.js',
          'src/diagnostics/deduplicator.js',
          'src/patch/conflict-guard.js',
          'src/pipeline/report-builder.js',
          'test/patch-diagnostics-baseline.test.js',
        ],
        noiseFiles: [
          'src/legacy/v1-regex-linter.js',
          'src/legacy/v1-patch-shim.js',
          'src/telemetry/diagnostic-sampler.js',
          'docs/CHANGELOG.md',
          'docs/HISTORICAL-DIAGNOSTICS.md',
          'fixtures/sample-tsc-output.json',
          'fixtures/historical-lint-traces.csv',
          'templates/patch-report.html',
        ],
      },
    }),
  },

  // 6) aci-06-swarm-contract-integration
  {
    id: 'aci-06-swarm-contract-integration',
    area: 'swarm_contract_integration',
    title: 'Parallel Swarm Contract Validation, 3-Way Merge & Reviewer Hard-Gate Integration',
    objective: 'Integrate writeScope contract enforcement, executable-preserving 3-way line merge, terminal CAS transitions, and hard reviewer git-diff/test-exit verification.',
    prompt: [
      'Inspect `CONTRACT.json`, `SPEC.md`, and `src/index.js`.',
      'Fix the Swarm contract integration pipeline ONLY in:',
      '1. `src/contracts/schema-registry.js`: implement `validateWorkerContractOutput(contract, payload)` verifying confined paths, `writeScope` ownership, required fields, and canonical `outputDigest` (`CONTRACT_DIGEST_MISMATCH`).',
      '2. `src/merge/three-way-merger.js`: replace naive last-writer-wins with line-level 3-way merge (`mergeParallelArtifacts(baseFiles, workerOutputs)`) that auto-merges disjoint hunks, emits `<<<<<<<`/`=======`/`>>>>>>>` conflict markers + `conflicts` entries on overlapping incompatible edits, and preserves `mode: "0o755"` executable permissions.',
      '3. `src/gates/reviewer-gate.js`: implement `evaluateReviewerHardGate({ claimedVerdict, gitDiffFiles, testExitCode, mergeConflicts })` refusing `"pass"` whenever `gitDiffFiles` is empty (`NO_VERIFIED_GIT_DIFF`), `testExitCode !== 0` (`TEST_EXECUTION_FAILED`), or `mergeConflicts` is non-empty (`UNRESOLVED_MERGE_CONFLICTS`).',
      '4. `src/coordinator/integration-runner.js`: implement CAS `transitionTerminalState(currentState, nextState)` (`completed|failed|cancelled` immutable once reached) and `runContractIntegration` chaining validation -> merge -> hard gate -> canonical `integrationDigest`.',
      'Do NOT modify `CONTRACT.json`, `SPEC.md`, or `test/swarm-contract-baseline.test.js`.',
      'Run `node --test test/swarm-contract-baseline.test.js` after editing.',
    ].join('\n'),
    fixture: {
      files: {
        'package.json': JSON.stringify({ name: 'aci-06-swarm-integration', version: '1.0.0', type: 'module' }, null, 2) + '\n',
        'README.md': '# Swarm Contract Integration\nEntrypoint: `src/index.js`. Governed by `CONTRACT.json` and `SPEC.md`.\n',
        'CONTRACT.json': ACI_06_CONTRACT_JSON,
        'SPEC.md': ACI_06_SPEC,
        'src/index.js': [
          "export { validateWorkerContractOutput, computeWorkerOutputDigest } from './contracts/schema-registry.js';",
          "export { mergeParallelArtifacts } from './merge/three-way-merger.js';",
          "export { evaluateReviewerHardGate } from './gates/reviewer-gate.js';",
          "export { transitionTerminalState, runContractIntegration } from './coordinator/integration-runner.js';",
        ].join('\n') + '\n',
        'src/contracts/schema-registry.js': [
          "import { createHash } from 'node:crypto';",
          'export function computeWorkerOutputDigest(nodeKey, changedFiles = []) {',
          '  return createHash("sha256").update(JSON.stringify({ nodeKey, changedFiles })).digest("hex");',
          '}',
          'export function validateWorkerContractOutput(contract, payload) {',
          '  if (!payload || !payload.nodeKey) return { ok: false, code: "INVALID_PAYLOAD" };',
          '  return { ok: true, code: "OK" };',
          '}',
        ].join('\n') + '\n',
        'src/merge/three-way-merger.js': [
          'export function mergeParallelArtifacts(baseFiles = {}, workerOutputs = []) {',
          '  const merged = {};',
          '  for (const [p, v] of Object.entries(baseFiles || {})) {',
          '    merged[p] = typeof v === "string" ? { content: v, mode: "0o644" } : { content: v.content ?? "", mode: v.mode ?? "0o644" };',
          '  }',
          '  for (const w of Array.isArray(workerOutputs) ? workerOutputs : []) {',
          '    for (const f of w?.changedFiles ?? []) {',
          '      merged[f.path] = { content: String(f.content ?? ""), mode: "0o644" };',
          '    }',
          '  }',
          '  return { files: merged, conflicts: [] };',
          '}',
        ].join('\n') + '\n',
        'src/gates/reviewer-gate.js': [
          'export function evaluateReviewerHardGate({ claimedVerdict = "pass", gitDiffFiles = [], testExitCode = null, mergeConflicts = [] } = {}) {',
          '  const count = Array.isArray(gitDiffFiles) ? gitDiffFiles.length : 0;',
          '  return {',
          '    verifiedGitDiff: count > 0,',
          '    diffFileCount: count,',
          '    verifiedTestExitCode: testExitCode,',
          '    hardGatePassed: claimedVerdict === "pass",',
          '    verdict: claimedVerdict,',
          '    reasons: [],',
          '  };',
          '}',
        ].join('\n') + '\n',
        'src/coordinator/integration-runner.js': [
          "import { createHash } from 'node:crypto';",
          "import { validateWorkerContractOutput } from '../contracts/schema-registry.js';",
          "import { mergeParallelArtifacts } from '../merge/three-way-merger.js';",
          "import { evaluateReviewerHardGate } from '../gates/reviewer-gate.js';",
          'export function transitionTerminalState(currentState, nextState) {',
          '  return { ok: true, state: nextState, overwritten: true };',
          '}',
          'export function runContractIntegration({ contract, baseFiles = {}, workerOutputs = [], claimedVerdict = "pass", testExitCode = 0 } = {}) {',
          '  for (const w of workerOutputs) validateWorkerContractOutput(contract, w);',
          '  const merged = mergeParallelArtifacts(baseFiles, workerOutputs);',
          '  const reviewerVerification = evaluateReviewerHardGate({ claimedVerdict, gitDiffFiles: Object.keys(merged.files), testExitCode, mergeConflicts: merged.conflicts });',
          '  return { ok: true, merged, reviewerVerification, integrationDigest: createHash("sha256").update(JSON.stringify(merged)).digest("hex") };',
          '}',
        ].join('\n') + '\n',
        'test/swarm-contract-baseline.test.js': [
          "import test from 'node:test';",
          "import assert from 'node:assert/strict';",
          "import { computeWorkerOutputDigest, runContractIntegration } from '../src/index.js';",
          "test('baseline swarm contract runner merges single-worker output', () => {",
          '  const changedFiles = [{ path: "src/a.js", content: "export const a = 1;\\n" }];',
          '  const worker = { nodeKey: "worker-1", writeScope: ["src/a.js"], changedFiles, outputDigest: computeWorkerOutputDigest("worker-1", changedFiles) };',
          '  const res = runContractIntegration({',
          '    contract: { terminalStates: ["completed", "failed", "cancelled"] },',
          '    baseFiles: {},',
          '    workerOutputs: [worker],',
          '    claimedVerdict: "pass",',
          '    testExitCode: 0,',
          '  });',
          '  assert.equal(res.reviewerVerification.hardGatePassed, true);',
          '  assert.equal(res.merged.files["src/a.js"].content, "export const a = 1;\\n");',
          '});',
        ].join('\n') + '\n',
        'src/legacy/v1-naive-overlay.js': buildLegacyJsDecoy({
          moduleLabel: 'v1-naive-overlay',
          domainKeywords: ['mergeParallelArtifacts', 'three-way', 'writeScope', 'overlay'],
          exportsList: ['overlayArtifactsNaive', 'restoreV1Snapshot'],
        }),
        'src/legacy/v1-dag-scheduler.js': buildLegacyJsDecoy({
          moduleLabel: 'v1-dag-scheduler',
          domainKeywords: ['transitionTerminalState', 'nodeKey', 'reviewerVerification', 'swarm'],
          exportsList: ['scheduleV1Dag', 'dispatchLegacyWorker'],
        }),
        'src/compat/legacy-event-bus.js': buildLegacyJsDecoy({
          moduleLabel: 'legacy-event-bus',
          domainKeywords: ['evaluateReviewerHardGate', 'CONTRACT', 'swarm', 'mailbox'],
          exportsList: ['publishLegacySwarmEvent', 'subscribeLegacyBus'],
        }),
        'docs/CHANGELOG.md': buildChangelogDecoy({
          title: 'Swarm Contract Integration',
          keywords: ['schema-registry', 'three-way-merger', 'reviewer-gate', 'integration-runner'],
        }),
        'docs/LEGACY-SWARM-NOTES.md': buildMarkdownArchiveDecoy({
          title: 'Legacy Swarm Coordination Notes',
          keywords: ['three-way', 'CAS', 'hardGatePassed', 'writeScope'],
          sections: 20,
        }),
        'fixtures/legacy-worker-traces.json': buildJsonFixtureDecoy({
          title: 'Legacy Worker Coordination Traces',
          keywords: ['workerOutputs', 'gitDiffFiles', 'testExitCode', 'outputDigest'],
        }),
        'fixtures/legacy-merge-metrics.sql': buildSqlDecoy({
          tableName: 'legacy_swarm_merge_metrics',
          keywords: ['merge', 'conflict', 'reviewer', 'cas'],
          rows: 85,
        }),
        'plugins/sample-swarm-openapi.json': buildOpenApiDecoy({
          serviceName: 'Legacy Swarm V1',
          keywords: ['swarm', 'merge', 'reviewer', 'artifact'],
        }),
      },
      baselineTestFiles: ['test/swarm-contract-baseline.test.js'],
      baselineTestCommand: ['node', '--test', 'test/swarm-contract-baseline.test.js'],
    },
    judge: makeAciGovernanceJudge({
      requiredSourceFiles: [
        'src/contracts/schema-registry.js',
        'src/merge/three-way-merger.js',
        'src/gates/reviewer-gate.js',
        'src/coordinator/integration-runner.js',
      ],
      protectedReadOnlyFiles: [
        'CONTRACT.json',
        'SPEC.md',
        'test/swarm-contract-baseline.test.js',
      ],
      rootCauseFiles: [
        'src/contracts/schema-registry.js',
        'src/merge/three-way-merger.js',
        'src/gates/reviewer-gate.js',
        'src/coordinator/integration-runner.js',
      ],
      extraCheck: ({ workspaceRoot }) => {
        const pkg = readWorkspaceJson(workspaceRoot, 'package.json');
        const regSrc = readWorkspaceText(workspaceRoot, 'src/contracts/schema-registry.js') ?? '';
        const mergeSrc = readWorkspaceText(workspaceRoot, 'src/merge/three-way-merger.js') ?? '';
        const gateSrc = readWorkspaceText(workspaceRoot, 'src/gates/reviewer-gate.js') ?? '';
        const runnerSrc = readWorkspaceText(workspaceRoot, 'src/coordinator/integration-runner.js') ?? '';
        const c1 = !pkg?.dependencies || Object.keys(pkg.dependencies).length === 0;
        const c2 =
          /export\s+function\s+validateWorkerContractOutput/.test(regSrc) &&
          /export\s+function\s+mergeParallelArtifacts/.test(mergeSrc) &&
          /export\s+function\s+evaluateReviewerHardGate/.test(gateSrc) &&
          /export\s+function\s+transitionTerminalState/.test(runnerSrc) &&
          /export\s+function\s+runContractIntegration/.test(runnerSrc);
        return { constraintsPreserved: c1 && c2 };
      },
      hiddenAcceptanceScript: `
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ws = process.env.WORKSPACE_ROOT || process.env.AGENT_US_EVAL_WORKSPACE;

test('hidden acceptance: schema registry rejects writeScope escape and outputDigest mismatch', async () => {
  const { validateWorkerContractOutput, computeWorkerOutputDigest } = await import(
    pathToFileURL(join(ws, 'src/index.js')).href
  );
  const contract = JSON.parse(readFileSync(join(ws, 'CONTRACT.json'), 'utf8'));
  const files = [{ path: 'src/allowed/mod.js', content: 'export const x = 1;\\n' }];
  const goodDigest = computeWorkerOutputDigest('w-a', files);

  const okRes = validateWorkerContractOutput(contract, {
    nodeKey: 'w-a',
    writeScope: ['src/allowed'],
    changedFiles: files,
    outputDigest: goodDigest,
  });
  assert.equal(okRes.ok, true);

  const scopeEscape = validateWorkerContractOutput(contract, {
    nodeKey: 'w-a',
    writeScope: ['src/allowed'],
    changedFiles: [{ path: 'src/other/mod.js', content: 'x' }],
    outputDigest: computeWorkerOutputDigest('w-a', [{ path: 'src/other/mod.js', content: 'x' }]),
  });
  assert.equal(scopeEscape.ok, false);

  const badDigest = validateWorkerContractOutput(contract, {
    nodeKey: 'w-a',
    writeScope: ['src/allowed'],
    changedFiles: files,
    outputDigest: '0'.repeat(64),
  });
  assert.equal(badDigest.ok, false);
  assert.match(badDigest.code, /DIGEST/i);
});

test('hidden acceptance: 3-way merger merges disjoint parallel edits, detects conflicts, and preserves 0o755 mode', async () => {
  const { mergeParallelArtifacts } = await import(pathToFileURL(join(ws, 'src/index.js')).href);
  const base = {
    'bin/run.sh': { content: '#!/bin/sh\\n# header\\necho start\\necho mid\\necho end\\n', mode: '0o755' },
  };
  const workerA = {
    nodeKey: 'worker-a',
    changedFiles: [{ path: 'bin/run.sh', content: '#!/bin/sh\\n# header-A\\necho start\\necho mid\\necho end\\n', mode: '0o755' }],
  };
  const workerB = {
    nodeKey: 'worker-b',
    changedFiles: [{ path: 'bin/run.sh', content: '#!/bin/sh\\n# header\\necho start\\necho mid\\necho end-B\\n', mode: '0o644' }],
  };
  const cleanMerge = mergeParallelArtifacts(base, [workerA, workerB]);
  assert.equal(cleanMerge.conflicts.length, 0);
  assert.equal(cleanMerge.files['bin/run.sh'].mode, '0o755');
  assert.equal(cleanMerge.files['bin/run.sh'].content.includes('# header-A'), true);
  assert.equal(cleanMerge.files['bin/run.sh'].content.includes('echo end-B'), true);

  const workerC = {
    nodeKey: 'worker-c',
    changedFiles: [{ path: 'bin/run.sh', content: '#!/bin/sh\\n# header-C\\necho start\\necho mid\\necho end\\n', mode: '0o755' }],
  };
  const conflicted = mergeParallelArtifacts(base, [workerA, workerC]);
  assert.equal(conflicted.conflicts.length, 1);
  assert.equal(conflicted.conflicts[0].path, 'bin/run.sh');
  assert.equal(conflicted.files['bin/run.sh'].content.includes('<<<<<<<'), true);
  assert.equal(conflicted.files['bin/run.sh'].content.includes('>>>>>>>'), true);
});

test('hidden acceptance: reviewer hard gate blocks synthetic pass and transitionTerminalState enforces CAS', async () => {
  const { evaluateReviewerHardGate, transitionTerminalState, runContractIntegration, computeWorkerOutputDigest } = await import(
    pathToFileURL(join(ws, 'src/index.js')).href
  );
  const contract = JSON.parse(readFileSync(join(ws, 'CONTRACT.json'), 'utf8'));

  const noDiff = evaluateReviewerHardGate({ claimedVerdict: 'pass', gitDiffFiles: [], testExitCode: 0, mergeConflicts: [] });
  assert.equal(noDiff.hardGatePassed, false);
  assert.equal(noDiff.verdict, 'fail');
  assert.equal(noDiff.reasons.includes('NO_VERIFIED_GIT_DIFF'), true);

  const badTest = evaluateReviewerHardGate({ claimedVerdict: 'pass', gitDiffFiles: ['src/a.js'], testExitCode: 1, mergeConflicts: [] });
  assert.equal(badTest.hardGatePassed, false);
  assert.equal(badTest.verdict, 'fail');
  assert.equal(badTest.reasons.includes('TEST_EXECUTION_FAILED'), true);

  const casBlocked = transitionTerminalState('completed', 'failed');
  assert.equal(casBlocked.ok, false);
  assert.equal(casBlocked.state, 'completed');
  assert.equal(casBlocked.overwritten, false);

  const casOk = transitionTerminalState('running', 'completed');
  assert.equal(casOk.ok, true);
  assert.equal(casOk.state, 'completed');

  const files = [{ path: 'src/x.js', content: 'export const x = 42;\\n', mode: '0o755' }];
  const integ = runContractIntegration({
    contract,
    baseFiles: {},
    workerOutputs: [{ nodeKey: 'w1', writeScope: ['src'], changedFiles: files, outputDigest: computeWorkerOutputDigest('w1', files) }],
    claimedVerdict: 'pass',
    testExitCode: 0,
  });
  assert.equal(integ.ok, true);
  assert.equal(integ.reviewerVerification.hardGatePassed, true);
  assert.match(integ.integrationDigest, /^[0-9a-f]{64}$/);
});
`,
    }),
    metadata: buildTaskMetadata({
      id: 'aci-06-swarm-contract-integration',
      area: 'swarm_contract_integration',
      requiredChangedFiles: [
        'src/contracts/schema-registry.js',
        'src/merge/three-way-merger.js',
        'src/gates/reviewer-gate.js',
        'src/coordinator/integration-runner.js',
      ],
      testFiles: ['test/swarm-contract-baseline.test.js'],
      testCommand: ['node', '--test', 'test/swarm-contract-baseline.test.js'],
      repoFileCount: 18,
      groundTruth: {
        criticalFiles: [
          'CONTRACT.json',
          'SPEC.md',
          'src/contracts/schema-registry.js',
          'src/merge/three-way-merger.js',
          'src/gates/reviewer-gate.js',
          'src/coordinator/integration-runner.js',
        ],
        relevantFiles: [
          'package.json',
          'README.md',
          'CONTRACT.json',
          'SPEC.md',
          'src/index.js',
          'src/contracts/schema-registry.js',
          'src/merge/three-way-merger.js',
          'src/gates/reviewer-gate.js',
          'src/coordinator/integration-runner.js',
          'test/swarm-contract-baseline.test.js',
        ],
        noiseFiles: [
          'src/legacy/v1-naive-overlay.js',
          'src/legacy/v1-dag-scheduler.js',
          'src/compat/legacy-event-bus.js',
          'docs/CHANGELOG.md',
          'docs/LEGACY-SWARM-NOTES.md',
          'fixtures/legacy-worker-traces.json',
          'fixtures/legacy-merge-metrics.sql',
          'plugins/sample-swarm-openapi.json',
        ],
      },
    }),
  },
].map((raw) => finalizeRawAciTask(raw, { is25: true }));

const RAW_ACI_25_TASKS = [...RAW_ACI_TASKS, ...RAW_ACI_25_ONLY_TASKS];

const RAW_ACI_26_ONLY_TASKS = [
  // 7) aci-07-cross-module-evolution
  {
    id: 'aci-07-cross-module-evolution',
    area: 'cross_module_evolution',
    title: 'Cross-Module Contract, Adapter, Event Pipeline & State Validator Evolution',
    objective: 'Evolve v1 ingestion to strict v2 schema validation, canonical SHA-256 envelope adaptation, terminal state immutability, and contract-required pipeline-runner caller fixes across 4 modules.',
    prompt: [
      'Inspect `CONTRACT.json`, `SPEC.md`, `src/index.js`, and `src/core/evolution-codes.js`.',
      'Evolve the cross-module event pipeline ONLY in:',
      '1. `src/validators/state-validator.js`: enforce terminal-state immutability (`TERMINAL_STATE_IMMUTABLE`), contract transition rules (`INVALID_STATE_TRANSITION`), and strict v2 envelope validation (`validateEvolutionEnvelope`).',
      '2. `src/adapters/v2-envelope-adapter.js`: compute canonical SHA-256 `computeEnvelopeDigest`, enforce strict `verifyEnvelopeChecksum`, and evolve `adaptV1ToV2Envelope` to migrate v1 (`traceId`/`requestId`, `tenantId`) without falling back to `"default"` (`MISSING_CORRELATION_ID` / `INVALID_PARTITION_KEY`).',
      '3. `src/pipeline/event-transformer.js`: update `transformPipelineBatch(events, options)` to require `options.contract` (`MISSING_CONTRACT`), adapt/validate/checksum-verify every event, and compute canonical `batchDigest`.',
      '4. `src/cli/pipeline-runner.js`: update caller `runEvolutionPipeline` to fail closed on missing contract or invalid state transitions and pass `{ contract, allowV1Migration }` to `transformPipelineBatch` with canonical `pipelineDigest`.',
      'Do NOT modify `CONTRACT.json`, `SPEC.md`, or `test/evolution-baseline.test.js`. Keep `evolution-codes.js`, `audit-summary.js`, and `index.js` unchanged and read-only.',
      'Run `node --test test/evolution-baseline.test.js` after editing to verify callers and baseline compatibility.',
    ].join('\n'),
    fixture: {
      files: {
        'package.json': JSON.stringify({ name: 'aci-07-cross-module-evolution', version: '2.0.0', type: 'module' }, null, 2) + '\n',
        'README.md': '# Cross-Module Event Evolution Pipeline\nEntrypoint: `src/index.js`. Governed by `CONTRACT.json` and `SPEC.md`.\n',
        'CONTRACT.json': ACI_07_CONTRACT_JSON,
        'SPEC.md': ACI_07_SPEC,
        'src/index.js': [
          "export { EVOLUTION_CODES, EVOLUTION_INVARIANTS, canonicalJson, sha256Hex } from './core/evolution-codes.js';",
          "export { validateStateTransition, validateEvolutionEnvelope } from './validators/state-validator.js';",
          "export { adaptV1ToV2Envelope, computeEnvelopeDigest, verifyEnvelopeChecksum } from './adapters/v2-envelope-adapter.js';",
          "export { transformPipelineBatch } from './pipeline/event-transformer.js';",
          "export { runEvolutionPipeline } from './cli/pipeline-runner.js';",
          "export { summarizeEvolutionRun } from './reporting/audit-summary.js';",
        ].join('\n') + '\n',
        'src/core/evolution-codes.js': ACI_07_EVOLUTION_CODES,
        'src/reporting/audit-summary.js': [
          'export function summarizeEvolutionRun({ accepted = [], rejected = [], state = "pending", pipelineDigest = null } = {}) {',
          '  return {',
          '    acceptedCount: Array.isArray(accepted) ? accepted.length : 0,',
          '    rejectedCount: Array.isArray(rejected) ? rejected.length : 0,',
          '    state: String(state || "pending"),',
          '    pipelineDigest: pipelineDigest ?? null,',
          '  };',
          '}',
        ].join('\n') + '\n',
        'src/validators/state-validator.js':
          ACI_07_STATE_VALIDATOR_HEADER +
          [
            'export function validateStateTransition(currentState, nextState, contract = {}) {',
            '  return { ok: true, code: EVOLUTION_CODES.OK, state: nextState, overwritten: false };',
            '}',
            'export function validateEvolutionEnvelope(envelope, contract = {}) {',
            '  if (!envelope || !envelope.eventId) {',
            '    return { ok: false, code: EVOLUTION_CODES.INVALID_SCHEMA_VERSION };',
            '  }',
            '  return { ok: true, code: EVOLUTION_CODES.OK };',
            '}',
          ].join('\n') + '\n',
        'src/adapters/v2-envelope-adapter.js':
          ACI_07_ADAPTER_HEADER +
          [
            'export function computeEnvelopeDigest(envelope = {}) {',
            '  return sha256Hex(JSON.stringify(envelope ?? {}));',
            '}',
            'export function verifyEnvelopeChecksum(envelope) {',
            '  return Boolean(envelope && typeof envelope.checksum === "string");',
            '}',
            'export function adaptV1ToV2Envelope(rawEvent, { allowV1Migration = true } = {}) {',
            '  const ev = rawEvent && typeof rawEvent === "object" ? rawEvent : {};',
            '  return {',
            '    ok: true,',
            '    migrationApplied: false,',
            '    envelope: {',
            '      schemaVersion: 2,',
            '      eventId: String(ev.eventId || ev.id || ""),',
            '      correlationId: String(ev.correlationId || ""),',
            '      partitionKey: String(ev.partitionKey || "default"),',
            '      state: String(ev.state || "pending"),',
            '      payload: ev.payload ?? {},',
            '      checksum: ev.checksum ?? computeEnvelopeDigest(ev),',
            '    },',
            '  };',
            '}',
          ].join('\n') + '\n',
        'src/pipeline/event-transformer.js': [
          "import { EVOLUTION_CODES, canonicalJson, sha256Hex } from '../core/evolution-codes.js';",
          "import { adaptV1ToV2Envelope, computeEnvelopeDigest } from '../adapters/v2-envelope-adapter.js';",
          "import { validateEvolutionEnvelope } from '../validators/state-validator.js';",
          'export function transformPipelineBatch(events = [], options = {}) {',
          '  const accepted = [];',
          '  const rejected = [];',
          '  for (const ev of Array.isArray(events) ? events : []) {',
          '    const adapted = adaptV1ToV2Envelope(ev);',
          '    const check = validateEvolutionEnvelope(adapted.envelope, options?.contract);',
          '    if (!check.ok) { rejected.push({ eventId: ev?.eventId ?? null, code: check.code }); continue; }',
          '    accepted.push({ ...adapted.envelope, digest: computeEnvelopeDigest(adapted.envelope), migrationApplied: adapted.migrationApplied });',
          '  }',
          '  return { ok: rejected.length === 0, code: EVOLUTION_CODES.OK, accepted, rejected, batchDigest: sha256Hex(canonicalJson({ accepted, rejected })) };',
          '}',
        ].join('\n') + '\n',
        'src/cli/pipeline-runner.js': [
          "import { EVOLUTION_CODES, canonicalJson, sha256Hex } from '../core/evolution-codes.js';",
          "import { validateStateTransition } from '../validators/state-validator.js';",
          "import { transformPipelineBatch } from '../pipeline/event-transformer.js';",
          "import { summarizeEvolutionRun } from '../reporting/audit-summary.js';",
          'export function runEvolutionPipeline({ contract, currentState = "pending", nextState = "running", events = [] } = {}) {',
          '  const transition = validateStateTransition(currentState, nextState, contract);',
          '  const transformed = transformPipelineBatch(events);',
          '  return {',
          '    ok: Boolean(transition.ok && transformed.ok),',
          '    code: EVOLUTION_CODES.OK,',
          '    state: transition.state ?? nextState,',
          '    accepted: transformed.accepted ?? [],',
          '    rejected: transformed.rejected ?? [],',
          '    batchDigest: transformed.batchDigest ?? null,',
          '    pipelineDigest: sha256Hex(canonicalJson({ state: nextState, accepted: transformed.accepted ?? [] })),',
          '    summary: summarizeEvolutionRun({ accepted: transformed.accepted, rejected: transformed.rejected, state: nextState }),',
          '  };',
          '}',
        ].join('\n') + '\n',
        'fixtures/baseline-events.json': ACI_07_BASELINE_EVENTS,
        'test/evolution-baseline.test.js': [
          "import test from 'node:test';",
          "import assert from 'node:assert/strict';",
          "import { readFileSync } from 'node:fs';",
          "import { join } from 'node:path';",
          "import { runEvolutionPipeline } from '../src/index.js';",
          "test('baseline evolution pipeline processes valid v2 event across pending -> running transition', () => {",
          '  const contract = JSON.parse(readFileSync(join(import.meta.dirname, "..", "CONTRACT.json"), "utf8"));',
          '  const events = JSON.parse(readFileSync(join(import.meta.dirname, "..", "fixtures", "baseline-events.json"), "utf8"));',
          '  const res = runEvolutionPipeline({ contract, currentState: "pending", nextState: "running", events });',
          '  assert.equal(res.ok, true);',
          '  assert.equal(res.state, "running");',
          '  assert.equal(res.accepted.length, 1);',
          '  assert.equal(res.rejected.length, 0);',
          '});',
        ].join('\n') + '\n',
        'src/legacy/v1-state-machine.js': buildLegacyJsDecoy({
          moduleLabel: 'v1-state-machine',
          domainKeywords: ['validateStateTransition', 'terminalStates', 'pending', 'running', 'completed'],
          exportsList: ['transitionV1State', 'resetLegacyState'],
        }),
        'src/legacy/v1-event-normalizer.js': buildLegacyJsDecoy({
          moduleLabel: 'v1-event-normalizer',
          domainKeywords: ['adaptV1ToV2Envelope', 'partitionKey', 'correlationId', 'schemaVersion'],
          exportsList: ['normalizeLegacyV1Event', 'coerceV1TenantFallback'],
        }),
        'src/compat/v1-adapter-shim.js': buildLegacyJsDecoy({
          moduleLabel: 'v1-adapter-shim',
          domainKeywords: ['computeEnvelopeDigest', 'verifyEnvelopeChecksum', 'traceId', 'requestId'],
          exportsList: ['shimLegacyEnvelope', 'bypassV1Checksum'],
        }),
        'src/telemetry/evolution-metrics-exporter.js': buildLegacyJsDecoy({
          moduleLabel: 'evolution-metrics-exporter',
          domainKeywords: ['runEvolutionPipeline', 'transformPipelineBatch', 'batchDigest', 'pipelineDigest'],
          exportsList: ['exportEvolutionTelemetry', 'flushLegacyPipelineCounters'],
        }),
        'docs/CHANGELOG.md': buildChangelogDecoy({
          title: 'Event Evolution Pipeline',
          keywords: ['state-validator', 'v2-envelope-adapter', 'event-transformer', 'pipeline-runner'],
        }),
        'docs/HISTORICAL-MIGRATIONS.md': buildMarkdownArchiveDecoy({
          title: 'Historical V1 Schema Migration Archive',
          keywords: ['TERMINAL_STATE_IMMUTABLE', 'MISSING_CONTRACT', 'INVALID_PARTITION_KEY', 'CHECKSUM_MISMATCH'],
          sections: 20,
        }),
        'fixtures/legacy-evolution-traces.json': buildJsonFixtureDecoy({
          title: 'Legacy V1 Pipeline Evolution Traces',
          keywords: ['schemaVersion', 'correlationId', 'partitionKey', 'pipelineDigest'],
        }),
        'templates/migration-report.html': buildHtmlTemplateDecoy({
          title: 'V1 to V2 Pipeline Migration Report',
          keywords: ['evolution', 'envelope', 'validator', 'checksum'],
        }),
      },
      baselineTestFiles: ['test/evolution-baseline.test.js'],
      baselineTestCommand: ['node', '--test', 'test/evolution-baseline.test.js'],
    },
    judge: makeAciGovernanceJudge({
      requiredSourceFiles: [
        'src/validators/state-validator.js',
        'src/adapters/v2-envelope-adapter.js',
        'src/pipeline/event-transformer.js',
        'src/cli/pipeline-runner.js',
      ],
      protectedReadOnlyFiles: [
        'CONTRACT.json',
        'SPEC.md',
        'src/core/evolution-codes.js',
        'src/reporting/audit-summary.js',
        'src/index.js',
        'fixtures/baseline-events.json',
        'test/evolution-baseline.test.js',
      ],
      rootCauseFiles: [
        'src/validators/state-validator.js',
        'src/adapters/v2-envelope-adapter.js',
        'src/pipeline/event-transformer.js',
        'src/cli/pipeline-runner.js',
      ],
      extraCheck: ({ workspaceRoot }) => {
        const pkg = readWorkspaceJson(workspaceRoot, 'package.json');
        const valSrc = readWorkspaceText(workspaceRoot, 'src/validators/state-validator.js') ?? '';
        const adpSrc = readWorkspaceText(workspaceRoot, 'src/adapters/v2-envelope-adapter.js') ?? '';
        const trSrc = readWorkspaceText(workspaceRoot, 'src/pipeline/event-transformer.js') ?? '';
        const runSrc = readWorkspaceText(workspaceRoot, 'src/cli/pipeline-runner.js') ?? '';
        const c1 = !pkg?.dependencies || Object.keys(pkg.dependencies).length === 0;
        const c2 =
          /export\s+function\s+validateStateTransition/.test(valSrc) &&
          /export\s+function\s+validateEvolutionEnvelope/.test(valSrc) &&
          /export\s+function\s+adaptV1ToV2Envelope/.test(adpSrc) &&
          /export\s+function\s+computeEnvelopeDigest/.test(adpSrc) &&
          /export\s+function\s+verifyEnvelopeChecksum/.test(adpSrc) &&
          /export\s+function\s+transformPipelineBatch/.test(trSrc) &&
          /export\s+function\s+runEvolutionPipeline/.test(runSrc);
        return { constraintsPreserved: c1 && c2 };
      },
      hiddenAcceptanceScript: `
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ws = process.env.WORKSPACE_ROOT || process.env.AGENT_US_EVAL_WORKSPACE;

test('hidden acceptance: state validator enforces terminal immutability and strict v2 envelope rules', async () => {
  const { validateStateTransition, validateEvolutionEnvelope, EVOLUTION_CODES } = await import(
    pathToFileURL(join(ws, 'src/index.js')).href
  );
  const contract = JSON.parse(readFileSync(join(ws, 'CONTRACT.json'), 'utf8'));

  const okTrans = validateStateTransition('pending', 'running', contract);
  assert.equal(okTrans.ok, true);
  assert.equal(okTrans.state, 'running');

  const termBlocked = validateStateTransition('completed', 'running', contract);
  assert.equal(termBlocked.ok, false);
  assert.equal(termBlocked.code, EVOLUTION_CODES.TERMINAL_STATE_IMMUTABLE);
  assert.equal(termBlocked.state, 'completed');

  const badSkip = validateStateTransition('pending', 'completed', contract);
  assert.equal(badSkip.ok, false);
  assert.equal(badSkip.code, EVOLUTION_CODES.INVALID_STATE_TRANSITION);

  const missingCorr = validateEvolutionEnvelope({
    schemaVersion: 2,
    eventId: 'e1',
    correlationId: '   ',
    partitionKey: 'tenant-1',
    state: 'pending',
    payload: {},
  }, contract);
  assert.equal(missingCorr.ok, false);
  assert.equal(missingCorr.code, EVOLUTION_CODES.MISSING_CORRELATION_ID);

  const badPk = validateEvolutionEnvelope({
    schemaVersion: 2,
    eventId: 'e2',
    correlationId: 'c2',
    partitionKey: '../bad',
    state: 'pending',
    payload: {},
  }, contract);
  assert.equal(badPk.ok, false);
  assert.equal(badPk.code, EVOLUTION_CODES.INVALID_PARTITION_KEY);
});

test('hidden acceptance: v2 adapter migrates v1 safely without default fallback and verifies canonical digests', async () => {
  const { adaptV1ToV2Envelope, computeEnvelopeDigest, verifyEnvelopeChecksum, EVOLUTION_CODES } = await import(
    pathToFileURL(join(ws, 'src/index.js')).href
  );

  const migrated = adaptV1ToV2Envelope({
    schemaVersion: 1,
    id: 'evt-v1-1',
    traceId: 'trace-99',
    tenantId: 'TENANT-BETA',
    state: 'pending',
    payload: { b: 2, a: 1 },
  });
  assert.equal(migrated.ok, true);
  assert.equal(migrated.migrationApplied, true);
  assert.equal(migrated.envelope.schemaVersion, 2);
  assert.equal(migrated.envelope.correlationId, 'trace-99');
  assert.equal(migrated.envelope.partitionKey, 'tenant-beta');
  assert.equal(verifyEnvelopeChecksum(migrated.envelope), true);

  const reorderedDigest = computeEnvelopeDigest({
    ...migrated.envelope,
    payload: { a: 1, b: 2 },
  });
  assert.equal(reorderedDigest, migrated.envelope.checksum);

  const tampered = { ...migrated.envelope, payload: { a: 1, b: 999 } };
  assert.equal(verifyEnvelopeChecksum(tampered), false);

  const noTenant = adaptV1ToV2Envelope({
    schemaVersion: 1,
    eventId: 'evt-v1-2',
    traceId: 'trace-2',
    payload: {},
  });
  assert.equal(noTenant.ok, false);
  assert.equal(noTenant.code, EVOLUTION_CODES.INVALID_PARTITION_KEY);
});

test('hidden acceptance: event-transformer requires contract and pipeline-runner caller integrates end-to-end', async () => {
  const { transformPipelineBatch, runEvolutionPipeline, computeEnvelopeDigest, EVOLUTION_CODES } = await import(
    pathToFileURL(join(ws, 'src/index.js')).href
  );
  const contract = JSON.parse(readFileSync(join(ws, 'CONTRACT.json'), 'utf8'));

  const noContract = transformPipelineBatch([]);
  assert.equal(noContract.ok, false);
  assert.equal(noContract.code, EVOLUTION_CODES.MISSING_CONTRACT);

  const badChecksumEvt = {
    schemaVersion: 2,
    eventId: 'evt-bad-chk',
    correlationId: 'corr-bad',
    partitionKey: 'tenant-1',
    state: 'pending',
    payload: { ok: false },
    checksum: '0'.repeat(64),
  };
  const goodV1Evt = {
    schemaVersion: 1,
    eventId: 'evt-good-1',
    requestId: 'req-1',
    tenantId: 'tenant-gamma',
    state: 'running',
    payload: { x: 1 },
  };
  const goodV2Evt = {
    schemaVersion: 2,
    eventId: 'evt-good-2',
    correlationId: 'corr-2',
    partitionKey: 'tenant-delta',
    state: 'running',
    payload: { y: 2 },
  };
  goodV2Evt.checksum = computeEnvelopeDigest(goodV2Evt);

  const mixed = runEvolutionPipeline({
    contract,
    currentState: 'pending',
    nextState: 'running',
    events: [goodV1Evt, badChecksumEvt],
  });
  assert.equal(mixed.ok, false);
  assert.equal(mixed.code, EVOLUTION_CODES.BATCH_REJECTED);
  assert.equal(mixed.accepted.length, 1);
  assert.equal(mixed.rejected.length, 1);
  assert.equal(mixed.rejected[0].code, EVOLUTION_CODES.CHECKSUM_MISMATCH);

  const blockedTerm = runEvolutionPipeline({
    contract,
    currentState: 'completed',
    nextState: 'running',
    events: [goodV2Evt],
  });
  assert.equal(blockedTerm.ok, false);
  assert.equal(blockedTerm.code, EVOLUTION_CODES.TERMINAL_STATE_IMMUTABLE);
  assert.equal(blockedTerm.accepted.length, 0);

  const okRun = runEvolutionPipeline({
    contract,
    currentState: 'pending',
    nextState: 'running',
    events: [goodV1Evt, goodV2Evt],
  });
  assert.equal(okRun.ok, true);
  assert.equal(okRun.code, EVOLUTION_CODES.OK);
  assert.equal(okRun.accepted.length, 2);
  assert.match(okRun.pipelineDigest, /^[0-9a-f]{64}$/);
});
`,
    }),
    metadata: buildTaskMetadata({
      id: 'aci-07-cross-module-evolution',
      area: 'cross_module_evolution',
      requiredChangedFiles: [
        'src/validators/state-validator.js',
        'src/adapters/v2-envelope-adapter.js',
        'src/pipeline/event-transformer.js',
        'src/cli/pipeline-runner.js',
      ],
      testFiles: ['test/evolution-baseline.test.js'],
      testCommand: ['node', '--test', 'test/evolution-baseline.test.js'],
      repoFileCount: 21,
      groundTruth: {
        criticalFiles: [
          'CONTRACT.json',
          'SPEC.md',
          'src/core/evolution-codes.js',
          'src/validators/state-validator.js',
          'src/adapters/v2-envelope-adapter.js',
          'src/pipeline/event-transformer.js',
          'src/cli/pipeline-runner.js',
        ],
        relevantFiles: [
          'package.json',
          'README.md',
          'CONTRACT.json',
          'SPEC.md',
          'src/index.js',
          'src/core/evolution-codes.js',
          'src/reporting/audit-summary.js',
          'src/validators/state-validator.js',
          'src/adapters/v2-envelope-adapter.js',
          'src/pipeline/event-transformer.js',
          'src/cli/pipeline-runner.js',
          'fixtures/baseline-events.json',
          'test/evolution-baseline.test.js',
        ],
        noiseFiles: [
          'src/legacy/v1-state-machine.js',
          'src/legacy/v1-event-normalizer.js',
          'src/compat/v1-adapter-shim.js',
          'src/telemetry/evolution-metrics-exporter.js',
          'docs/CHANGELOG.md',
          'docs/HISTORICAL-MIGRATIONS.md',
          'fixtures/legacy-evolution-traces.json',
          'templates/migration-report.html',
        ],
      },
    }),
  },
].map((raw) => finalizeRawAciTask(raw, { is26: true }));

const RAW_ACI_26_TASKS = [...RAW_ACI_25_TASKS, ...RAW_ACI_26_ONLY_TASKS];

export const ACI_GOVERNANCE_DATASET = Object.freeze(RAW_ACI_TASKS);
export const ACI_GOVERNANCE_25_DATASET = Object.freeze(RAW_ACI_25_TASKS);
export const ACI_GOVERNANCE_26_DATASET = Object.freeze(RAW_ACI_26_TASKS);

export function createAciGovernanceDataset({
  sandbox = null,
  sandboxOptions = null,
  repoOverrides = null,
  suite = 'aci',
  include25 = false,
  include26 = false,
} = {}) {
  const datasetSandbox =
    sandbox ?? (sandboxOptions ? new BenchmarkSandbox(sandboxOptions) : getDefaultBenchmarkSandbox());
  const sourceTasks =
    include26 || suite === 'aci26' || suite === 'all'
      ? RAW_ACI_26_TASKS
      : include25 || suite === 'aci25'
        ? RAW_ACI_25_TASKS
        : RAW_ACI_TASKS;
  return sourceTasks.map((task) => {
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

export async function materializeAciGovernanceRepos(rootDir, { tasks = null, suite = 'aci' } = {}) {
  const targetTasks =
    tasks ??
    (suite === 'aci26' || suite === 'all'
      ? RAW_ACI_26_TASKS
      : suite === 'aci25'
        ? RAW_ACI_25_TASKS
        : RAW_ACI_TASKS);
  const baseRoot = resolve(String(rootDir));
  mkdirSync(baseRoot, { recursive: true });
  const repoOverrides = {};
  const entries = await Promise.all(
    targetTasks.map(async (task) => {
      const work = join(baseRoot, `${task.id}-src`);
      const bare = join(baseRoot, `${task.id}.git`);
      rmSync(work, { recursive: true, force: true });
      rmSync(bare, { recursive: true, force: true });
      mkdirSync(work, { recursive: true });
      const fileEntries = Object.entries(task.fixture.files).sort(([a], [b]) => a.localeCompare(b));
      for (const [rel, body] of fileEntries) {
        const abs = join(work, rel);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileText(abs, String(body));
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

function writeFileText(absPath, content) {
  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(absPath, content, 'utf8');
}

export async function instantiateAciGovernanceWorkspace(task, options = {}) {
  const workspaceRoot = await createFixtureWorkspace(task, options);
  runHardenedGitSync(['config', 'core.filemode', 'false'], { cwd: workspaceRoot, allowNetwork: false });
  return workspaceRoot;
}

export function getAciGovernanceReferenceFix(taskId, workspaceRoot = null) {
  switch (taskId) {
    case 'aci-01-auth-tenant-boundary':
      return {
        'src/middleware/tenant-context.js': [
          "import { getRuntimeOptions } from '../core/runtime-options.js';",
          "import { AUTH_ERROR_CODES, authError } from '../core/error-codes.js';",
          'const BLOCKED_TENANT_KEYS = new Set(["__proto__", "constructor", "prototype"]);',
          'function readTenantHeader(headers = {}) {',
          '  for (const [k, v] of Object.entries(headers || {})) {',
          '    if (k.toLowerCase() === "x-tenant-id") return v;',
          '  }',
          '  return undefined;',
          '}',
          'export function resolveTenantContext({ headers = {}, claims = null, runtimeOptions = getRuntimeOptions() } = {}) {',
          '  const claimsTenant = typeof claims?.tenantId === "string" ? claims.tenantId.trim() : "";',
          '  if (!claimsTenant) {',
          '    return authError(403, AUTH_ERROR_CODES.TENANT_CONTEXT_MISSING, "Missing claims.tenantId");',
          '  }',
          '  const rawHeader = readTenantHeader(headers);',
          '  if (Array.isArray(rawHeader)) {',
          '    return authError(403, AUTH_ERROR_CODES.TENANT_MISMATCH, "Multi-value tenant header rejected");',
          '  }',
          '  const headerTenant = typeof rawHeader === "string" ? rawHeader.trim() : rawHeader === undefined ? "" : null;',
          '  if (headerTenant === null || /[\\s,]/.test(headerTenant)) {',
          '    return authError(403, AUTH_ERROR_CODES.TENANT_MISMATCH, "Invalid tenant header");',
          '  }',
          '  if (BLOCKED_TENANT_KEYS.has(claimsTenant) || (headerTenant && BLOCKED_TENANT_KEYS.has(headerTenant))) {',
          '    return authError(403, AUTH_ERROR_CODES.TENANT_FORBIDDEN_KEY, "Forbidden tenant identifier");',
          '  }',
          '  if (headerTenant && runtimeOptions.strictTenantIsolation !== false && headerTenant !== claimsTenant) {',
          '    return authError(403, AUTH_ERROR_CODES.TENANT_MISMATCH, "Cross-tenant access denied");',
          '  }',
          '  const suspended = Array.isArray(runtimeOptions.suspendedTenants) ? runtimeOptions.suspendedTenants : [];',
          '  if (suspended.includes(claimsTenant)) {',
          '    return authError(403, AUTH_ERROR_CODES.TENANT_SUSPENDED, "Tenant is suspended");',
          '  }',
          '  return { ok: true, tenantId: claimsTenant, strict: runtimeOptions.strictTenantIsolation !== false };',
          '}',
        ].join('\n') + '\n',
        'src/auth/rbac-guard.js': [
          "import { getRuntimeOptions } from '../core/runtime-options.js';",
          "import { AUTH_ERROR_CODES } from '../core/error-codes.js';",
          'export const ROLE_PERMISSIONS = Object.freeze({',
          '  viewer: Object.freeze(["docs:read", "metrics:read"]),',
          '  editor: Object.freeze(["docs:read", "docs:write", "metrics:read"]),',
          '  admin: Object.freeze(["docs:read", "docs:write", "docs:delete", "metrics:read", "billing:read", "billing:write"]),',
          '});',
          'export function authorizeRequest({ claims, tenantContext, action, runtimeOptions = getRuntimeOptions() } = {}) {',
          '  const act = typeof action === "string" ? action.trim() : "";',
          '  if (!claims || typeof claims !== "object" || !tenantContext?.ok || !tenantContext.tenantId || !act) {',
          '    return { allowed: false, status: 403, code: AUTH_ERROR_CODES.RBAC_DENIED };',
          '  }',
          '  if (claims.tenantId !== tenantContext.tenantId) {',
          '    return { allowed: false, status: 403, code: AUTH_ERROR_CODES.TENANT_MISMATCH };',
          '  }',
          '  let effectiveRoles = [];',
          '  if (claims.tenantRoles && typeof claims.tenantRoles === "object" && !Array.isArray(claims.tenantRoles)) {',
          '    if (Object.hasOwn(claims.tenantRoles, tenantContext.tenantId) && Array.isArray(claims.tenantRoles[tenantContext.tenantId])) {',
          '      effectiveRoles = claims.tenantRoles[tenantContext.tenantId];',
          '    }',
          '  } else if (Array.isArray(claims.roles)) {',
          '    effectiveRoles = claims.roles;',
          '  }',
          '  if (!effectiveRoles.length) {',
          '    return { allowed: false, status: 403, code: AUTH_ERROR_CODES.RBAC_DENIED };',
          '  }',
          '  for (const role of effectiveRoles) {',
          '    if (typeof role !== "string") continue;',
          '    if (role === "*" || role.endsWith(":*")) {',
          '      if (runtimeOptions.allowWildcardRole !== true) {',
          '        return { allowed: false, status: 403, code: AUTH_ERROR_CODES.RBAC_WILDCARD_FORBIDDEN };',
          '      }',
          '    }',
          '    if (!Object.hasOwn(ROLE_PERMISSIONS, role)) continue;',
          '    if (ROLE_PERMISSIONS[role].includes(act)) {',
          '      return { allowed: true, status: 200, code: "OK", tenantId: tenantContext.tenantId };',
          '    }',
          '  }',
          '  return { allowed: false, status: 403, code: AUTH_ERROR_CODES.RBAC_DENIED, tenantId: tenantContext.tenantId };',
          '}',
        ].join('\n') + '\n',
      };

    case 'aci-02-persistence-wal-ledger':
      return {
        'src/persistence/wal-store.js':
          ACI_02_WAL_STORE_HEADER +
          [
            'export function verifyWalChecksum(record) {',
            '  if (!record || typeof record !== "object") return false;',
            '  if (!Number.isInteger(record.seq) || record.seq <= 0) return false;',
            '  if (typeof record.idempotencyKey !== "string" || !record.idempotencyKey) return false;',
            '  if (typeof record.account !== "string" || !record.account) return false;',
            '  if (!Number.isInteger(record.deltaCents)) return false;',
            '  return record.crc === computeWalRecordCrc(record);',
            '}',
            'export function appendWalRecord(walPath, entry) {',
            '  if (!entry || !Number.isInteger(entry.seq) || entry.seq <= 0 || !entry.idempotencyKey || !entry.account || !Number.isInteger(entry.deltaCents)) {',
            '    throw new TypeError("Invalid WAL entry");',
            '  }',
            '  const rec = { seq: entry.seq, idempotencyKey: String(entry.idempotencyKey), account: String(entry.account), deltaCents: entry.deltaCents };',
            '  const full = { ...rec, crc: computeWalRecordCrc(rec) };',
            '  appendFileSync(walPath, JSON.stringify(full) + "\\n", "utf8");',
            '  return full;',
            '}',
            'export function replayWal(walPath, { allowCorruptTail = true } = {}) {',
            '  if (!existsSync(walPath)) return { records: [], truncatedTail: false, corruptTailCount: 0 };',
            '  const lines = readFileSync(walPath, "utf8").split(/\\r?\\n/).filter((l) => l.trim().length > 0);',
            '  const records = [];',
            '  let truncatedTail = false;',
            '  let corruptTailCount = 0;',
            '  for (let i = 0; i < lines.length; i++) {',
            '    let parsed = null;',
            '    let valid = false;',
            '    try {',
            '      parsed = JSON.parse(lines[i]);',
            '      valid = verifyWalChecksum(parsed);',
            '    } catch { valid = false; }',
            '    if (!valid) {',
            '      const isFinalLine = i === lines.length - 1;',
            '      if (isFinalLine && allowCorruptTail) {',
            '        truncatedTail = true;',
            '        corruptTailCount = 1;',
            '        break;',
            '      }',
            '      throw new Error(`WAL_CRC_MISMATCH: corrupt frame at line ${i + 1}`);',
            '    }',
            '    records.push(parsed);',
            '  }',
            '  records.sort((a, b) => Number(a.seq) - Number(b.seq));',
            '  return { records, truncatedTail, corruptTailCount };',
            '}',
          ].join('\n') + '\n',
        'src/persistence/checkpoint-reconciler.js': [
          "import { existsSync, writeFileSync } from 'node:fs';",
          "import { applyLedgerEntry, computeLedgerDigest } from '../api/ledger-contract.js';",
          "import { replayWal } from './wal-store.js';",
          'export function reconcileCheckpoint(checkpointState = {}, walRecords = []) {',
          '  let balances = { ...(checkpointState?.balances ?? {}) };',
          '  let lastAppliedSeq = Number(checkpointState?.lastAppliedSeq ?? 0);',
          '  const appliedKeys = new Set(Array.isArray(checkpointState?.appliedKeys) ? checkpointState.appliedKeys.map(String) : []);',
          '  const sorted = [...(walRecords || [])].sort((a, b) => Number(a.seq) - Number(b.seq));',
          '  let appliedCount = 0;',
          '  let skippedDuplicates = 0;',
          '  for (const rec of sorted) {',
          '    const seq = Number(rec?.seq);',
          '    const key = String(rec?.idempotencyKey ?? "");',
          '    if (!Number.isInteger(seq) || seq <= lastAppliedSeq || !key || appliedKeys.has(key)) {',
          '      skippedDuplicates += 1;',
          '      continue;',
          '    }',
          '    balances = applyLedgerEntry(balances, rec);',
          '    appliedKeys.add(key);',
          '    lastAppliedSeq = seq;',
          '    appliedCount += 1;',
          '  }',
          '  const keysList = [...appliedKeys].sort();',
          '  const digest = computeLedgerDigest({ lastAppliedSeq, appliedKeys: keysList, balances });',
          '  return { lastAppliedSeq, appliedKeys: keysList, balances, digest, appliedCount, skippedDuplicates };',
          '}',
          'export function compactWal(walPath, checkpointState = {}) {',
          '  if (!existsSync(walPath)) return { remainingCount: 0 };',
          '  const lastSeq = Number(checkpointState?.lastAppliedSeq ?? 0);',
          '  const appliedKeys = new Set(Array.isArray(checkpointState?.appliedKeys) ? checkpointState.appliedKeys.map(String) : []);',
          '  const { records } = replayWal(walPath, { allowCorruptTail: true });',
          '  const remaining = records.filter((r) => Number(r.seq) > lastSeq && !appliedKeys.has(String(r.idempotencyKey)));',
          '  const body = remaining.length ? remaining.map((r) => JSON.stringify(r)).join("\\n") + "\\n" : "";',
          '  writeFileSync(walPath, body, "utf8");',
          '  return { remainingCount: remaining.length };',
          '}',
        ].join('\n') + '\n',
      };

    case 'aci-03-contract-pipeline-refactor':
      return {
        'src/pipeline/normalizer.js': [
          'const BLOCKED_KEYS = new Set(["__proto__", "constructor", "prototype"]);',
          'function isPlainObject(v) { return Boolean(v) && typeof v === "object" && !Array.isArray(v); }',
          'export function normalizeKey(key) {',
          '  return String(key ?? "").trim().replace(/[\\s-]+/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "").toLowerCase();',
          '}',
          'export function normalizeConfigLayer(rawLayer = {}) {',
          '  if (!isPlainObject(rawLayer)) return {};',
          '  const out = {};',
          '  for (const key of Object.keys(rawLayer)) {',
          '    if (BLOCKED_KEYS.has(key)) continue;',
          '    const val = rawLayer[key];',
          '    if (val === undefined || val === null) continue;',
          '    const normKey = normalizeKey(key);',
          '    if (!normKey || BLOCKED_KEYS.has(normKey)) continue;',
          '    out[normKey] = isPlainObject(val) ? normalizeConfigLayer(val) : val;',
          '  }',
          '  return out;',
          '}',
        ].join('\n') + '\n',
        'src/pipeline/loader.js': [
          "import { normalizeConfigLayer } from './normalizer.js';",
          'export function loadConfigLayers(rawSources = {}) {',
          '  return {',
          '    defaults: normalizeConfigLayer(rawSources?.defaults),',
          '    workspace: normalizeConfigLayer(rawSources?.workspace),',
          '    env: normalizeConfigLayer(rawSources?.env),',
          '    cli: normalizeConfigLayer(rawSources?.cli),',
          '  };',
          '}',
        ].join('\n') + '\n',
        'src/pipeline/precedence-resolver.js': [
          'export const PRECEDENCE_ORDER = Object.freeze(["cli", "env", "workspace", "defaults"]);',
          'export function resolvePrecedence(layers = {}) {',
          '  const effectiveConfig = {};',
          '  const provenance = {};',
          '  for (const layerName of PRECEDENCE_ORDER) {',
          '    const layer = layers?.[layerName];',
          '    if (!layer || typeof layer !== "object") continue;',
          '    for (const key of Object.keys(layer)) {',
          '      if (Object.hasOwn(effectiveConfig, key)) continue;',
          '      effectiveConfig[key] = layer[key];',
          '      provenance[key] = layerName;',
          '    }',
          '  }',
          '  return { effectiveConfig, provenance };',
          '}',
        ].join('\n') + '\n',
        'src/pipeline/evaluator.js': [
          "import { createHash } from 'node:crypto';",
          "import { validateRule } from './schema-validator.js';",
          'function canonical(v) {',
          '  if (v === null || typeof v !== "object") return JSON.stringify(v);',
          '  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";',
          '  return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}";',
          '}',
          'export function evaluateConfig(resolved = {}) {',
          '  const effectiveConfig = {};',
          '  const provenance = {};',
          '  for (const k of Object.keys(resolved.effectiveConfig || {}).sort()) {',
          '    effectiveConfig[k] = resolved.effectiveConfig[k];',
          '    if (resolved.provenance && Object.hasOwn(resolved.provenance, k)) {',
          '      provenance[k] = resolved.provenance[k];',
          '    }',
          '  }',
          '  const evaluatedRules = Object.keys(effectiveConfig).map((k) => validateRule(k, effectiveConfig[k]));',
          '  const checksum = createHash("sha256").update(canonical({ effectiveConfig, provenance, evaluatedRules }), "utf8").digest("hex");',
          '  return { effectiveConfig, provenance, evaluatedRules, checksum };',
          '}',
        ].join('\n') + '\n',
      };

    case 'aci-04-long-horizon-security-audit': {
      const pathGuardSrc = [
        "import { lstatSync, readlinkSync, realpathSync } from 'node:fs';",
        "import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';",
        'function realExisting(target) {',
        '  const realFn = typeof realpathSync.native === "function" ? realpathSync.native : realpathSync;',
        '  let cur = resolve(target);',
        '  for (let i = 0; i < 16; i++) {',
        '    try { return realFn(cur); } catch (err) {',
        '      if (err?.code !== "ENOENT" && err?.code !== "ENOTDIR") throw err;',
        '      let lst = null;',
        '      try { lst = lstatSync(cur); } catch { lst = null; }',
        '      if (lst?.isSymbolicLink()) {',
        '        const linkTarget = readlinkSync(cur);',
        '        cur = isAbsolute(linkTarget) ? resolve(linkTarget) : resolve(dirname(cur), linkTarget);',
        '        continue;',
        '      }',
        '      const parent = dirname(cur);',
        '      if (parent === cur) return cur;',
        '      return join(realExisting(parent), relative(parent, cur));',
        '    }',
        '  }',
        '  throw new Error("Symlink depth exceeded");',
        '}',
        'export function confineAuditPath(rootDir, candidatePath) {',
        '  if (typeof candidatePath !== "string" || !candidatePath.trim()) throw new Error("Empty candidate path");',
        '  const raw = candidatePath.trim();',
        '  if (raw.includes("\\0") || /%(?:00|25|2e|2f|5c)/i.test(raw) || /^[a-zA-Z]:/.test(raw) || raw.startsWith("/") || raw.startsWith("\\\\")) {',
        '    throw new Error("Blocked encoded or absolute path");',
        '  }',
        '  const norm = raw.replaceAll("\\\\", "/");',
        '  if (norm.split("/").some((seg) => seg === "..")) throw new Error("Path traversal blocked");',
        '  const realRoot = realExisting(rootDir);',
        '  const realTarget = realExisting(resolve(realRoot, norm));',
        '  const rel = relative(realRoot, realTarget);',
        '  if (!rel || rel === ".." || rel.startsWith(".." + sep) || rel.startsWith("../") || isAbsolute(rel)) {',
        '    throw new Error("Path escapes rootDir");',
        '  }',
        '  return realTarget;',
        '}',
      ].join('\n') + '\n';

      const policyEngineSrc =
        ACI_04_POLICY_ENGINE_HEADER +
        [
          'export function evaluateAccessPolicy({ actor = "anonymous", role = "", action = "", rootDir = process.cwd(), targetPath = "", auditStore = null } = {}) {',
          '  let allowed = false;',
          '  let reason = "POLICY_DENIED";',
          '  let resource = String(targetPath ?? "");',
          '  try {',
          '    confineAuditPath(rootDir, targetPath);',
          '    const perms = Object.hasOwn(ROLE_POLICIES, role) ? ROLE_POLICIES[role] : null;',
          '    if (Array.isArray(perms) && perms.includes(action)) {',
          '      allowed = true;',
          '      reason = "ALLOWED";',
          '    }',
          '  } catch {',
          '    allowed = false;',
          '    reason = "PATH_ESCAPE_BLOCKED";',
          '  }',
          '  if (auditStore && typeof auditStore.append === "function") {',
          '    auditStore.append({ actor, action, resource, allowed, reason });',
          '  }',
          '  return { allowed, reason, resource };',
          '}',
        ].join('\n') + '\n';

      const auditStoreSrc = [
        "import { createHash } from 'node:crypto';",
        'export const GENESIS_HASH = "0".repeat(64);',
        'function canonical(v) {',
        '  if (v === null || typeof v !== "object") return JSON.stringify(v);',
        '  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";',
        '  return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}";',
        '}',
        'function hashEntry(entry) {',
        '  return createHash("sha256").update(canonical({',
        '    seq: entry.seq,',
        '    prevHash: entry.prevHash,',
        '    actor: entry.actor,',
        '    action: entry.action,',
        '    resource: entry.resource,',
        '    allowed: Boolean(entry.allowed),',
        '    reason: String(entry.reason || ""),',
        '  }), "utf8").digest("hex");',
        '}',
        'export function verifyAuditChain(entries = []) {',
        '  if (!Array.isArray(entries)) return false;',
        '  let expectedPrev = GENESIS_HASH;',
        '  for (let i = 0; i < entries.length; i++) {',
        '    const e = entries[i];',
        '    if (!e || e.seq !== i + 1 || e.prevHash !== expectedPrev) return false;',
        '    if (e.entryHash !== hashEntry(e)) return false;',
        '    expectedPrev = e.entryHash;',
        '  }',
        '  return true;',
        '}',
        'export class AuditStore {',
        '  #entries = [];',
        '  append({ actor, action, resource, allowed, reason }) {',
        '    const seq = this.#entries.length + 1;',
        '    const prevHash = this.headHash();',
        '    const base = { seq, prevHash, actor: String(actor || ""), action: String(action || ""), resource: String(resource || ""), allowed: Boolean(allowed), reason: String(reason || "") };',
        '    const rec = { ...base, entryHash: hashEntry(base) };',
        '    this.#entries.push(rec);',
        '    return rec;',
        '  }',
        '  entries() { return [...this.#entries]; }',
        '  headHash() { return this.#entries.at(-1)?.entryHash ?? GENESIS_HASH; }',
        '  verifyChain() { return verifyAuditChain(this.#entries); }',
        '}',
      ].join('\n') + '\n';

      const auditExportSrc = [
        '#!/usr/bin/env node',
        "import { createHash } from 'node:crypto';",
        "import { readFileSync, writeFileSync } from 'node:fs';",
        "import { join, resolve } from 'node:path';",
        "import { evaluateAccessPolicy } from '../security/policy-engine.js';",
        "import { AuditStore, verifyAuditChain } from '../persistence/audit-store.js';",
        'function canonical(v) {',
        '  if (v === null || typeof v !== "object") return JSON.stringify(v);',
        '  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";',
        '  return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}";',
        '}',
        'const args = process.argv.slice(2);',
        'let inputPath = "fixtures/baseline-events.json";',
        'let rootDir = ".";',
        'let outPath = "AUDIT_REPORT.json";',
        'for (let i = 0; i < args.length; i++) {',
        '  if (args[i] === "--input") inputPath = args[++i];',
        '  else if (args[i] === "--root") rootDir = args[++i];',
        '  else if (args[i] === "--out") outPath = args[++i];',
        '}',
        'const absRoot = resolve(rootDir);',
        'const events = JSON.parse(readFileSync(resolve(absRoot, inputPath), "utf8"));',
        'const store = new AuditStore();',
        'for (const ev of events) {',
        '  evaluateAccessPolicy({ actor: ev.actor, role: ev.role, action: ev.action, rootDir: absRoot, targetPath: ev.targetPath, auditStore: store });',
        '}',
        'const entries = store.entries();',
        'const chainValid = verifyAuditChain(entries);',
        'const chainHeadHash = store.headHash();',
        'const tracked = ["src/cli/audit-export.js", "src/persistence/audit-store.js", "src/security/path-guard.js", "src/security/policy-engine.js"].sort();',
        'const artifactDigests = tracked.map((p) => ({ path: p, sha256: createHash("sha256").update(readFileSync(join(absRoot, p))).digest("hex") }));',
        'const rootDigestSha256 = createHash("sha256").update(canonical({ artifactDigests, chainHeadHash, chainValid }), "utf8").digest("hex");',
        'const report = { schemaVersion: "1.0.0", chainValid, eventCount: entries.length, chainHeadHash, artifactDigests, rootDigestSha256, entries };',
        'writeFileSync(resolve(absRoot, outPath), JSON.stringify(report, null, 2) + "\\n", "utf8");',
      ].join('\n') + '\n';

      const fixedFiles = {
        'src/security/path-guard.js': pathGuardSrc,
        'src/security/policy-engine.js': policyEngineSrc,
        'src/persistence/audit-store.js': auditStoreSrc,
        'src/cli/audit-export.js': auditExportSrc,
      };
      fixedFiles['AUDIT_REPORT.json'] = buildAci04FixedAuditReport(fixedFiles);
      return fixedFiles;
    }

    case 'aci-05-multi-module-patch-refactor':
      return {
        'src/diagnostics/parser.js': [
          'const ANSI_RE = /\\x1b\\[[0-9;]*m/g;',
          'function normalizeSeverity(raw = "") {',
          '  const s = String(raw || "").trim().toLowerCase();',
          '  if (s === "fatal" || s === "err" || s === "error" || s === "syntaxerror") return "error";',
          '  if (s === "warn" || s === "warning") return "warning";',
          '  return "info";',
          '}',
          'function normalizeFile(raw = "") {',
          '  return String(raw || "").trim().replaceAll("\\\\", "/").replace(/^\\.\\//, "");',
          '}',
          'export function parseDiagnosticLines(rawText = "") {',
          '  const cleaned = String(rawText ?? "").replace(ANSI_RE, "");',
          '  const lines = cleaned.split(/\\r?\\n/).map((l) => l.trim()).filter(Boolean);',
          '  const out = [];',
          '  for (const line of lines) {',
          '    const tsc = /^(.+?)\\((\\d+),(\\d+)\\):\\s*(error|warning|warn|info|fatal)\\s+([A-Za-z0-9_-]+):\\s*(.+)$/i.exec(line);',
          '    if (tsc) {',
          '      out.push({ file: normalizeFile(tsc[1]), line: Number(tsc[2]), column: Number(tsc[3]), severity: normalizeSeverity(tsc[4]), code: tsc[5], message: tsc[6].trim() });',
          '      continue;',
          '    }',
          '    const colon = /^([A-Za-z0-9_./\\\\-]+):(\\d+)(?::(\\d+))?:\\s*(?:(error|warning|warn|info|fatal|syntaxerror)\\s*(?:([A-Za-z0-9_-]+):\\s*)?|:?\\s*(.+))$/i.exec(line);',
          '    if (colon) {',
          '      const restIdx = line.indexOf(":", colon[1].length + 1 + colon[2].length + (colon[3] ? 1 + colon[3].length : 0));',
          '      const tail = restIdx >= 0 ? line.slice(restIdx + 1).trim() : "";',
          '      const sevMatch = /^(error|warning|warn|info|fatal|syntaxerror)(?:\\s+([A-Za-z0-9_-]+))?:\\s*(.+)$/i.exec(tail);',
          '      if (sevMatch) {',
          '        out.push({ file: normalizeFile(colon[1]), line: Number(colon[2]), column: colon[3] ? Number(colon[3]) : null, severity: normalizeSeverity(sevMatch[1]), code: sevMatch[2] || null, message: sevMatch[3].trim() });',
          '        continue;',
          '      }',
          '      const sevNoCode = /^(error|warning|warn|info|fatal|syntaxerror)\\s+([A-Za-z0-9_-]+):\\s*(.+)$/i.exec(tail);',
          '      if (sevNoCode) {',
          '        out.push({ file: normalizeFile(colon[1]), line: Number(colon[2]), column: colon[3] ? Number(colon[3]) : null, severity: normalizeSeverity(sevNoCode[1]), code: sevNoCode[2], message: sevNoCode[3].trim() });',
          '        continue;',
          '      }',
          '      out.push({ file: normalizeFile(colon[1]), line: Number(colon[2]), column: colon[3] ? Number(colon[3]) : null, severity: /error|fail/i.test(tail) ? "error" : /warn/i.test(tail) ? "warning" : "info", code: null, message: tail });',
          '      continue;',
          '    }',
          '    out.push({ file: null, line: null, column: null, severity: "info", code: null, message: line });',
          '  }',
          '  return out;',
          '}',
        ].join('\n') + '\n',
        'src/diagnostics/deduplicator.js': [
          "import { SEVERITY_ORDER } from '../core/diagnostic-codes.js';",
          'export function deduplicateDiagnostics(entries = [], { maxItems = 50 } = {}) {',
          '  const list = Array.isArray(entries) ? entries : [];',
          '  const map = new Map();',
          '  for (const raw of list) {',
          '    if (!raw || typeof raw !== "object") continue;',
          '    const file = raw.file ? String(raw.file).replaceAll("\\\\", "/").replace(/^\\.\\//, "") : null;',
          '    const line = Number.isInteger(raw.line) ? raw.line : null;',
          '    const column = Number.isInteger(raw.column) ? raw.column : null;',
          '    const severity = raw.severity === "error" || raw.severity === "warning" ? raw.severity : "info";',
          '    const code = raw.code ? String(raw.code) : null;',
          '    const message = String(raw.message ?? "").trim();',
          '    const key = `${file ?? ""}|${line ?? ""}|${code ?? ""}|${message}`;',
          '    const prev = map.get(key);',
          '    if (prev) {',
          '      prev.occurrenceCount += 1;',
          '      if (line !== null && (prev.firstSeenLine === null || line < prev.firstSeenLine)) {',
          '        prev.firstSeenLine = line;',
          '      }',
          '    } else {',
          '      map.set(key, { file, line, column, severity, code, message, occurrenceCount: 1, firstSeenLine: line });',
          '    }',
          '  }',
          '  const unique = [...map.values()].sort((a, b) => {',
          '    const sa = SEVERITY_ORDER[a.severity] ?? 9;',
          '    const sb = SEVERITY_ORDER[b.severity] ?? 9;',
          '    if (sa !== sb) return sa - sb;',
          '    const fa = a.file ?? "\\uffff";',
          '    const fb = b.file ?? "\\uffff";',
          '    if (fa !== fb) return fa.localeCompare(fb);',
          '    const la = a.line ?? Number.MAX_SAFE_INTEGER;',
          '    const lb = b.line ?? Number.MAX_SAFE_INTEGER;',
          '    if (la !== lb) return la - lb;',
          '    return a.message.localeCompare(b.message);',
          '  });',
          '  const cap = Number.isInteger(maxItems) && maxItems >= 0 ? maxItems : 50;',
          '  const items = unique.slice(0, cap);',
          '  const truncatedCount = Math.max(0, unique.length - items.length);',
          '  return {',
          '    items,',
          '    compression: { totalRaw: list.length, uniqueCount: unique.length, keptCount: items.length, truncatedCount },',
          '  };',
          '}',
        ].join('\n') + '\n',
        'src/patch/conflict-guard.js': [
          "import { PATCH_DIAGNOSTIC_CODES, sha256Hex } from '../core/diagnostic-codes.js';",
          'function normalizeConfinedRelPath(raw) {',
          '  if (typeof raw !== "string" || !raw.trim()) return null;',
          '  const p = raw.trim().replaceAll("\\\\", "/");',
          '  if (p.startsWith("/") || /^[a-zA-Z]:/.test(p)) return null;',
          '  const segs = p.split("/").filter(Boolean);',
          '  if (!segs.length || segs.some((s) => s === ".." || s === "." || s === ".git")) return null;',
          '  return segs.join("/");',
          '}',
          'function countLineDiff(before, after) {',
          '  const a = before === null ? [] : String(before).replace(/\\r\\n/g, "\\n").split("\\n");',
          '  const b = after === null ? [] : String(after).replace(/\\r\\n/g, "\\n").split("\\n");',
          '  let prefix = 0;',
          '  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;',
          '  let suffix = 0;',
          '  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;',
          '  return { deletions: Math.max(0, a.length - prefix - suffix), additions: Math.max(0, b.length - prefix - suffix) };',
          '}',
          'export function validatePatchBatch(hunks = [], fileContents = {}) {',
          '  const list = Array.isArray(hunks) ? hunks : [];',
          '  const conflicts = [];',
          '  const staged = [];',
          '  for (const h of list) {',
          '    const norm = normalizeConfinedRelPath(h?.path);',
          '    if (!norm) {',
          '      return { ok: false, code: PATCH_DIAGNOSTIC_CODES.PATH_CONFINEMENT_ERROR, conflicts: [{ path: String(h?.path ?? ""), reason: "path_confinement_violation" }], appliedFiles: {}, fileSummaries: [] };',
          '    }',
          '    const hasBefore = Object.hasOwn(fileContents || {}, norm);',
          '    const beforeText = hasBefore ? String(fileContents[norm]) : null;',
          '    const actualSha = beforeText !== null ? sha256Hex(beforeText) : null;',
          '    if (h.expectedSha256 !== undefined && h.expectedSha256 !== actualSha) {',
          '      conflicts.push({ path: norm, expectedSha256: h.expectedSha256, actualSha256: actualSha });',
          '      continue;',
          '    }',
          '    const afterText = h.after === null ? null : String(h.after ?? "");',
          '    const { additions, deletions } = countLineDiff(beforeText, afterText);',
          '    staged.push({ path: norm, afterText, additions, deletions, sha256After: afterText === null ? null : sha256Hex(afterText) });',
          '  }',
          '  if (conflicts.length > 0) {',
          '    return { ok: false, code: PATCH_DIAGNOSTIC_CODES.OPTIMISTIC_LOCK_CONFLICT, conflicts, appliedFiles: {}, fileSummaries: [] };',
          '  }',
          '  const appliedFiles = { ...(fileContents || {}) };',
          '  const fileSummaries = [];',
          '  for (const s of staged) {',
          '    if (s.afterText === null) delete appliedFiles[s.path];',
          '    else appliedFiles[s.path] = s.afterText;',
          '    fileSummaries.push({ path: s.path, additions: s.additions, deletions: s.deletions, sha256After: s.sha256After });',
          '  }',
          '  return { ok: true, code: PATCH_DIAGNOSTIC_CODES.OK, conflicts: [], appliedFiles, fileSummaries };',
          '}',
        ].join('\n') + '\n',
        'src/pipeline/report-builder.js': [
          "import { canonicalStringify, sha256Hex } from '../core/diagnostic-codes.js';",
          "import { parseDiagnosticLines } from '../diagnostics/parser.js';",
          "import { deduplicateDiagnostics } from '../diagnostics/deduplicator.js';",
          "import { validatePatchBatch } from '../patch/conflict-guard.js';",
          'export function buildPatchDiagnosticsReport({ hunks = [], fileContents = {}, rawDiagnostics = "", maxItems = 50 } = {}) {',
          '  const patch = validatePatchBatch(hunks, fileContents);',
          '  const parsed = parseDiagnosticLines(rawDiagnostics);',
          '  const diagnostics = deduplicateDiagnostics(parsed, { maxItems });',
          '  const ok = Boolean(patch.ok && diagnostics.items.every((d) => d.severity !== "error"));',
          '  const appliedPaths = patch.fileSummaries.map((f) => f.path).sort();',
          '  const reportDigest = sha256Hex(canonicalStringify({ ok, patchCode: patch.code, appliedPaths, items: diagnostics.items, compression: diagnostics.compression }));',
          '  return { ok, patch, diagnostics, reportDigest };',
          '}',
        ].join('\n') + '\n',
      };

    case 'aci-06-swarm-contract-integration':
      return {
        'src/contracts/schema-registry.js': [
          "import { createHash } from 'node:crypto';",
          'function canonical(v) {',
          '  if (v === null || typeof v !== "object") return JSON.stringify(v);',
          '  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";',
          '  return "{" + Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}";',
          '}',
          'function isConfinedPath(raw) {',
          '  if (typeof raw !== "string" || !raw.trim()) return false;',
          '  const p = raw.trim().replaceAll("\\\\", "/");',
          '  if (p.startsWith("/") || /^[a-zA-Z]:/.test(p)) return false;',
          '  const segs = p.split("/").filter(Boolean);',
          '  return segs.length > 0 && !segs.some((s) => s === ".." || s === "." || s === ".git");',
          '}',
          'function normRel(raw) {',
          '  return String(raw || "").trim().replaceAll("\\\\", "/").replace(/^\\.\\//, "").replace(/\\/+$/, "");',
          '}',
          'export function computeWorkerOutputDigest(nodeKey, changedFiles = []) {',
          '  const normFiles = (Array.isArray(changedFiles) ? changedFiles : [])',
          '    .map((f) => ({ path: normRel(f?.path), content: String(f?.content ?? "") }))',
          '    .sort((a, b) => a.path.localeCompare(b.path));',
          '  return createHash("sha256").update(canonical({ nodeKey: String(nodeKey || ""), changedFiles: normFiles }), "utf8").digest("hex");',
          '}',
          'export function validateWorkerContractOutput(contract, payload) {',
          '  if (!payload || typeof payload !== "object") return { ok: false, code: "INVALID_PAYLOAD" };',
          '  const nodeKey = typeof payload.nodeKey === "string" ? payload.nodeKey.trim() : "";',
          '  if (!nodeKey) return { ok: false, code: "MISSING_NODE_KEY" };',
          '  const scopes = Array.isArray(payload.writeScope) ? payload.writeScope.map(normRel).filter(Boolean) : [];',
          '  if (!scopes.length || !payload.writeScope.every(isConfinedPath)) return { ok: false, code: "INVALID_WRITE_SCOPE" };',
          '  if (!Array.isArray(payload.changedFiles)) return { ok: false, code: "INVALID_CHANGED_FILES" };',
          '  for (const f of payload.changedFiles) {',
          '    if (!isConfinedPath(f?.path)) return { ok: false, code: "PATH_CONFINEMENT_ERROR" };',
          '    const rel = normRel(f.path);',
          '    if (!scopes.some((s) => rel === s || rel.startsWith(`${s}/`))) {',
          '      return { ok: false, code: "WRITE_SCOPE_VIOLATION", path: rel };',
          '    }',
          '    if (f.mode && Array.isArray(contract?.allowedModes) && !contract.allowedModes.includes(f.mode)) {',
          '      return { ok: false, code: "INVALID_FILE_MODE", path: rel };',
          '    }',
          '  }',
          '  const expectedDigest = computeWorkerOutputDigest(nodeKey, payload.changedFiles);',
          '  if (payload.outputDigest !== expectedDigest) {',
          '    return { ok: false, code: "CONTRACT_DIGEST_MISMATCH", expectedDigest };',
          '  }',
          '  return { ok: true, code: "OK" };',
          '}',
        ].join('\n') + '\n',
        'src/merge/three-way-merger.js': [
          'function computeEditChunk(baseLines, targetLines) {',
          '  let start = 0;',
          '  while (start < baseLines.length && start < targetLines.length && baseLines[start] === targetLines[start]) start++;',
          '  let endB = baseLines.length;',
          '  let endT = targetLines.length;',
          '  while (endB > start && endT > start && baseLines[endB - 1] === targetLines[endT - 1]) {',
          '    endB--;',
          '    endT--;',
          '  }',
          '  if (start === endB && start === endT) return null;',
          '  return { start, end: endB, replacement: targetLines.slice(start, endT) };',
          '}',
          'export function mergeParallelArtifacts(baseFiles = {}, workerOutputs = []) {',
          '  const baseMap = new Map();',
          '  for (const [p, v] of Object.entries(baseFiles || {})) {',
          '    const content = typeof v === "string" ? v : String(v?.content ?? "");',
          '    const mode = typeof v === "object" && v?.mode === "0o755" ? "0o755" : "0o644";',
          '    baseMap.set(p, { content, mode });',
          '  }',
          '  const editsByPath = new Map();',
          '  for (const w of Array.isArray(workerOutputs) ? workerOutputs : []) {',
          '    const nodeKey = String(w?.nodeKey || "worker");',
          '    for (const f of w?.changedFiles ?? []) {',
          '      if (!f?.path) continue;',
          '      const list = editsByPath.get(f.path) ?? [];',
          '      list.push({ nodeKey, content: String(f.content ?? ""), mode: f.mode === "0o755" ? "0o755" : "0o644" });',
          '      editsByPath.set(f.path, list);',
          '    }',
          '  }',
          '  const files = {};',
          '  for (const [p, entry] of baseMap.entries()) files[p] = { ...entry };',
          '  const conflicts = [];',
          '  for (const [path, edits] of editsByPath.entries()) {',
          '    const base = baseMap.get(path) ?? { content: "", mode: "0o644" };',
          '    const hasExec = base.mode === "0o755" || edits.some((e) => e.mode === "0o755");',
          '    const mode = hasExec ? "0o755" : "0o644";',
          '    if (edits.length === 1) {',
          '      files[path] = { content: edits[0].content, mode };',
          '      continue;',
          '    }',
          '    const baseLines = base.content === "" ? [] : base.content.replace(/\\r\\n/g, "\\n").split("\\n");',
          '    const chunks = [];',
          '    for (const ed of edits) {',
          '      const targetLines = ed.content === "" ? [] : ed.content.replace(/\\r\\n/g, "\\n").split("\\n");',
          '      const chunk = computeEditChunk(baseLines, targetLines);',
          '      if (chunk) chunks.push({ ...chunk, nodeKey: ed.nodeKey, lines: targetLines });',
          '    }',
          '    if (chunks.length === 0) {',
          '      files[path] = { content: base.content, mode };',
          '      continue;',
          '    }',
          '    chunks.sort((a, b) => a.start - b.start || a.end - b.end);',
          '    const outLines = [];',
          '    let cursor = 0;',
          '    let hadConflict = false;',
          '    for (let i = 0; i < chunks.length; i++) {',
          '      const cur = chunks[i];',
          '      const nxt = chunks[i + 1];',
          '      const overlaps = nxt && (nxt.start < cur.end || (nxt.start === cur.start && nxt.end === cur.end));',
          '      if (overlaps) {',
          '        const same = JSON.stringify(cur.replacement) === JSON.stringify(nxt.replacement);',
          '        while (cursor < cur.start) outLines.push(baseLines[cursor++]);',
          '        if (same) {',
          '          outLines.push(...cur.replacement);',
          '          cursor = Math.max(cur.end, nxt.end);',
          '        } else {',
          '          hadConflict = true;',
          '          conflicts.push({ path, nodeKeys: [cur.nodeKey, nxt.nodeKey], reason: "overlapping_hunk_conflict" });',
          '          outLines.push(`<<<<<<< ${cur.nodeKey}`, ...cur.replacement, "=======", ...nxt.replacement, `>>>>>>> ${nxt.nodeKey}`);',
          '          cursor = Math.max(cur.end, nxt.end);',
          '        }',
          '        i++;',
          '        continue;',
          '      }',
          '      while (cursor < cur.start) outLines.push(baseLines[cursor++]);',
          '      outLines.push(...cur.replacement);',
          '      cursor = cur.end;',
          '    }',
          '    while (cursor < baseLines.length) outLines.push(baseLines[cursor++]);',
          '    const mergedText = outLines.join("\\n");',
          '    files[path] = { content: base.content.endsWith("\\n") && !mergedText.endsWith("\\n") && !hadConflict ? `${mergedText}\\n` : mergedText, mode };',
          '  }',
          '  return { files, conflicts };',
          '}',
        ].join('\n') + '\n',
        'src/gates/reviewer-gate.js': [
          'export function evaluateReviewerHardGate({ claimedVerdict = "fail", gitDiffFiles = [], testExitCode = null, mergeConflicts = [] } = {}) {',
          '  const diffs = Array.isArray(gitDiffFiles) ? gitDiffFiles.filter(Boolean) : [];',
          '  const conflicts = Array.isArray(mergeConflicts) ? mergeConflicts : [];',
          '  const reasons = [];',
          '  if (diffs.length === 0) reasons.push("NO_VERIFIED_GIT_DIFF");',
          '  if (testExitCode !== 0) reasons.push("TEST_EXECUTION_FAILED");',
          '  if (conflicts.length > 0) reasons.push("UNRESOLVED_MERGE_CONFLICTS");',
          '  const hardGatePassed = reasons.length === 0 && claimedVerdict === "pass";',
          '  return {',
          '    verifiedGitDiff: diffs.length > 0,',
          '    diffFileCount: diffs.length,',
          '    verifiedTestExitCode: testExitCode,',
          '    hardGatePassed,',
          '    verdict: hardGatePassed ? "pass" : "fail",',
          '    reasons,',
          '  };',
          '}',
        ].join('\n') + '\n',
        'src/coordinator/integration-runner.js': [
          "import { createHash } from 'node:crypto';",
          "import { validateWorkerContractOutput } from '../contracts/schema-registry.js';",
          "import { mergeParallelArtifacts } from '../merge/three-way-merger.js';",
          "import { evaluateReviewerHardGate } from '../gates/reviewer-gate.js';",
          'const TERMINAL_STATES = new Set(["completed", "failed", "cancelled"]);',
          'function canonical(v) {',
          '  if (v === null || typeof v !== "object") return JSON.stringify(v);',
          '  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";',
          '  return "{" + Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}";',
          '}',
          'export function transitionTerminalState(currentState, nextState) {',
          '  if (TERMINAL_STATES.has(currentState)) {',
          '    return { ok: false, state: currentState, overwritten: false };',
          '  }',
          '  return { ok: true, state: nextState, overwritten: false };',
          '}',
          'export function runContractIntegration({ contract, baseFiles = {}, workerOutputs = [], claimedVerdict = "pass", testExitCode = 0 } = {}) {',
          '  const validationErrors = [];',
          '  for (const w of Array.isArray(workerOutputs) ? workerOutputs : []) {',
          '    const check = validateWorkerContractOutput(contract, w);',
          '    if (!check.ok) validationErrors.push(check);',
          '  }',
          '  const merged = mergeParallelArtifacts(baseFiles, workerOutputs);',
          '  const changedPaths = [];',
          '  for (const [p, entry] of Object.entries(merged.files)) {',
          '    const baseEntry = baseFiles[p];',
          '    const baseText = typeof baseEntry === "string" ? baseEntry : baseEntry?.content;',
          '    if (baseText !== entry.content) changedPaths.push(p);',
          '  }',
          '  const reviewerVerification = evaluateReviewerHardGate({ claimedVerdict, gitDiffFiles: changedPaths, testExitCode, mergeConflicts: merged.conflicts });',
          '  const ok = validationErrors.length === 0 && reviewerVerification.hardGatePassed;',
          '  const integrationDigest = createHash("sha256").update(canonical({ ok, validationErrors, files: merged.files, conflicts: merged.conflicts, reviewerVerification }), "utf8").digest("hex");',
          '  return { ok, validationErrors, merged, reviewerVerification, integrationDigest };',
          '}',
        ].join('\n') + '\n',
      };

    case 'aci-07-cross-module-evolution':
      return {
        'src/validators/state-validator.js':
          ACI_07_STATE_VALIDATOR_HEADER +
          [
            'const DEFAULT_TERMINAL_STATES = new Set(["completed", "failed", "cancelled"]);',
            'const DEFAULT_TRANSITIONS = {',
            '  pending: ["running", "cancelled"],',
            '  running: ["completed", "failed", "cancelled"],',
            '  completed: [],',
            '  failed: [],',
            '  cancelled: [],',
            '};',
            'export function validateStateTransition(currentState, nextState, contract = {}) {',
            '  const terminals = Array.isArray(contract?.terminalStates) ? new Set(contract.terminalStates) : DEFAULT_TERMINAL_STATES;',
            '  if (terminals.has(currentState)) {',
            '    return { ok: false, code: EVOLUTION_CODES.TERMINAL_STATE_IMMUTABLE, state: currentState, overwritten: false };',
            '  }',
            '  const transitions = contract?.transitions && typeof contract.transitions === "object" ? contract.transitions : DEFAULT_TRANSITIONS;',
            '  const allowed = Array.isArray(transitions[currentState]) ? transitions[currentState] : [];',
            '  if (!allowed.includes(nextState)) {',
            '    return { ok: false, code: EVOLUTION_CODES.INVALID_STATE_TRANSITION, state: currentState, overwritten: false };',
            '  }',
            '  return { ok: true, code: EVOLUTION_CODES.OK, state: nextState, overwritten: false };',
            '}',
            'export function validateEvolutionEnvelope(envelope, contract = {}) {',
            '  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {',
            '    return { ok: false, code: EVOLUTION_CODES.INVALID_SCHEMA_VERSION };',
            '  }',
            '  if (Number(envelope.schemaVersion) !== 2) {',
            '    return { ok: false, code: EVOLUTION_CODES.INVALID_SCHEMA_VERSION };',
            '  }',
            '  if (typeof envelope.eventId !== "string" || !envelope.eventId.trim()) {',
            '    return { ok: false, code: EVOLUTION_CODES.INVALID_SCHEMA_VERSION };',
            '  }',
            '  if (typeof envelope.correlationId !== "string" || !envelope.correlationId.trim()) {',
            '    return { ok: false, code: EVOLUTION_CODES.MISSING_CORRELATION_ID };',
            '  }',
            '  const pkRe = new RegExp(contract?.partitionKeyPattern || "^[a-z0-9][a-z0-9._-]{1,63}$");',
            '  if (typeof envelope.partitionKey !== "string" || !pkRe.test(envelope.partitionKey.trim())) {',
            '    return { ok: false, code: EVOLUTION_CODES.INVALID_PARTITION_KEY };',
            '  }',
            '  const allowedStates = Array.isArray(contract?.allowedStates) ? contract.allowedStates : ["pending", "running", "completed", "failed", "cancelled"];',
            '  if (!allowedStates.includes(envelope.state)) {',
            '    return { ok: false, code: EVOLUTION_CODES.INVALID_STATE_TRANSITION };',
            '  }',
            '  if (!envelope.payload || typeof envelope.payload !== "object" || Array.isArray(envelope.payload)) {',
            '    return { ok: false, code: EVOLUTION_CODES.INVALID_SCHEMA_VERSION };',
            '  }',
            '  return { ok: true, code: EVOLUTION_CODES.OK };',
            '}',
          ].join('\n') + '\n',
        'src/adapters/v2-envelope-adapter.js':
          ACI_07_ADAPTER_HEADER +
          [
            'const PARTITION_KEY_RE = /^[a-z0-9][a-z0-9._-]{1,63}$/;',
            'export function computeEnvelopeDigest(envelope = {}) {',
            '  const env = envelope && typeof envelope === "object" ? envelope : {};',
            '  return sha256Hex(canonicalJson({',
            '    schemaVersion: Number(env.schemaVersion),',
            '    eventId: String(env.eventId || "").trim(),',
            '    correlationId: String(env.correlationId || "").trim(),',
            '    partitionKey: String(env.partitionKey || "").trim(),',
            '    state: String(env.state || "").trim(),',
            '    payload: env.payload ?? {},',
            '  }));',
            '}',
            'export function verifyEnvelopeChecksum(envelope) {',
            '  if (!envelope || typeof envelope !== "object" || typeof envelope.checksum !== "string") return false;',
            '  return envelope.checksum === computeEnvelopeDigest(envelope);',
            '}',
            'export function adaptV1ToV2Envelope(rawEvent, { allowV1Migration = true } = {}) {',
            '  if (!rawEvent || typeof rawEvent !== "object" || Array.isArray(rawEvent)) {',
            '    return { ok: false, code: EVOLUTION_CODES.INVALID_SCHEMA_VERSION };',
            '  }',
            '  const rawVersion = rawEvent.schemaVersion ?? 1;',
            '  if (Number(rawVersion) === 2) {',
            '    const base = {',
            '      schemaVersion: 2,',
            '      eventId: String(rawEvent.eventId || "").trim(),',
            '      correlationId: String(rawEvent.correlationId || "").trim(),',
            '      partitionKey: String(rawEvent.partitionKey || "").trim(),',
            '      state: String(rawEvent.state || "pending").trim(),',
            '      payload: rawEvent.payload && typeof rawEvent.payload === "object" && !Array.isArray(rawEvent.payload) ? rawEvent.payload : null,',
            '    };',
            '    const checksum = rawEvent.checksum !== undefined ? rawEvent.checksum : computeEnvelopeDigest(base);',
            '    return { ok: true, migrationApplied: false, envelope: { ...base, checksum } };',
            '  }',
            '  if (Number(rawVersion) !== 1 || !allowV1Migration) {',
            '    return { ok: false, code: EVOLUTION_CODES.INVALID_SCHEMA_VERSION };',
            '  }',
            '  const correlationId = String(rawEvent.correlationId ?? rawEvent.traceId ?? rawEvent.requestId ?? "").trim();',
            '  if (!correlationId) {',
            '    return { ok: false, code: EVOLUTION_CODES.MISSING_CORRELATION_ID };',
            '  }',
            '  const partitionKey = String(rawEvent.partitionKey ?? rawEvent.tenantId ?? "").trim().toLowerCase();',
            '  if (!PARTITION_KEY_RE.test(partitionKey)) {',
            '    return { ok: false, code: EVOLUTION_CODES.INVALID_PARTITION_KEY };',
            '  }',
            '  const base = {',
            '    schemaVersion: 2,',
            '    eventId: String(rawEvent.eventId || rawEvent.id || "").trim(),',
            '    correlationId,',
            '    partitionKey,',
            '    state: String(rawEvent.state || "pending").trim(),',
            '    payload: rawEvent.payload && typeof rawEvent.payload === "object" && !Array.isArray(rawEvent.payload) ? rawEvent.payload : {},',
            '  };',
            '  const checksum = rawEvent.checksum !== undefined ? rawEvent.checksum : computeEnvelopeDigest(base);',
            '  return { ok: true, migrationApplied: true, envelope: { ...base, checksum } };',
            '}',
          ].join('\n') + '\n',
        'src/pipeline/event-transformer.js': [
          "import { EVOLUTION_CODES, canonicalJson, sha256Hex } from '../core/evolution-codes.js';",
          "import { adaptV1ToV2Envelope, computeEnvelopeDigest, verifyEnvelopeChecksum } from '../adapters/v2-envelope-adapter.js';",
          "import { validateEvolutionEnvelope } from '../validators/state-validator.js';",
          'export function transformPipelineBatch(events = [], options = {}) {',
          '  if (!options || !options.contract || typeof options.contract !== "object") {',
          '    return { ok: false, code: EVOLUTION_CODES.MISSING_CONTRACT, accepted: [], rejected: [], batchDigest: null };',
          '  }',
          '  const accepted = [];',
          '  const rejected = [];',
          '  for (const ev of Array.isArray(events) ? events : []) {',
          '    const adapted = adaptV1ToV2Envelope(ev, { allowV1Migration: options.allowV1Migration !== false });',
          '    if (!adapted.ok) {',
          '      rejected.push({ eventId: ev?.eventId ?? ev?.id ?? null, code: adapted.code });',
          '      continue;',
          '    }',
          '    const valid = validateEvolutionEnvelope(adapted.envelope, options.contract);',
          '    if (!valid.ok) {',
          '      rejected.push({ eventId: adapted.envelope?.eventId ?? null, code: valid.code });',
          '      continue;',
          '    }',
          '    if (adapted.envelope.checksum !== undefined && !verifyEnvelopeChecksum(adapted.envelope)) {',
          '      rejected.push({ eventId: adapted.envelope.eventId, code: EVOLUTION_CODES.CHECKSUM_MISMATCH });',
          '      continue;',
          '    }',
          '    accepted.push({',
          '      ...adapted.envelope,',
          '      digest: computeEnvelopeDigest(adapted.envelope),',
          '      migrationApplied: adapted.migrationApplied,',
          '    });',
          '  }',
          '  const ok = rejected.length === 0;',
          '  const code = ok ? EVOLUTION_CODES.OK : EVOLUTION_CODES.BATCH_REJECTED;',
          '  const batchDigest = sha256Hex(canonicalJson({ accepted, rejected }));',
          '  return { ok, code, accepted, rejected, batchDigest };',
          '}',
        ].join('\n') + '\n',
        'src/cli/pipeline-runner.js': [
          "import { EVOLUTION_CODES, canonicalJson, sha256Hex } from '../core/evolution-codes.js';",
          "import { validateStateTransition } from '../validators/state-validator.js';",
          "import { transformPipelineBatch } from '../pipeline/event-transformer.js';",
          "import { summarizeEvolutionRun } from '../reporting/audit-summary.js';",
          'export function runEvolutionPipeline({ contract, currentState = "pending", nextState = "running", events = [], allowV1Migration = true } = {}) {',
          '  if (!contract || typeof contract !== "object") {',
          '    return {',
          '      ok: false,',
          '      code: EVOLUTION_CODES.MISSING_CONTRACT,',
          '      state: currentState,',
          '      accepted: [],',
          '      rejected: [],',
          '      batchDigest: null,',
          '      pipelineDigest: null,',
          '      summary: summarizeEvolutionRun({ state: currentState }),',
          '    };',
          '  }',
          '  const transition = validateStateTransition(currentState, nextState, contract);',
          '  if (!transition.ok) {',
          '    return {',
          '      ok: false,',
          '      code: transition.code,',
          '      state: transition.state,',
          '      accepted: [],',
          '      rejected: [],',
          '      batchDigest: null,',
          '      pipelineDigest: null,',
          '      summary: summarizeEvolutionRun({ state: transition.state }),',
          '    };',
          '  }',
          '  const transformed = transformPipelineBatch(events, { contract, allowV1Migration });',
          '  const pipelineDigest = sha256Hex(canonicalJson({ state: transition.state, accepted: transformed.accepted, rejected: transformed.rejected, batchDigest: transformed.batchDigest }));',
          '  return {',
          '    ok: Boolean(transformed.ok),',
          '    code: transformed.ok ? EVOLUTION_CODES.OK : transformed.code,',
          '    state: transition.state,',
          '    accepted: transformed.accepted,',
          '    rejected: transformed.rejected,',
          '    batchDigest: transformed.batchDigest,',
          '    pipelineDigest,',
          '    summary: summarizeEvolutionRun({ accepted: transformed.accepted, rejected: transformed.rejected, state: transition.state, pipelineDigest }),',
          '  };',
          '}',
        ].join('\n') + '\n',
      };

    default:
      throw new Error(`Unknown ACI governance taskId: ${taskId}`);
  }
}

export function buildAciGovernanceEvidenceOutput(task, changedFiles = null, overrides = {}) {
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

// ---------------------------------------------------------------------------
// 9 Governance Metrics Engine (Post-Hoc Ground Truth Scoring Only)
// ---------------------------------------------------------------------------

const TASK_BY_ID = new Map(RAW_ACI_26_TASKS.map((t) => [t.id, t]));

export function resolveAciTaskGroundTruth(taskOrId) {
  const id = typeof taskOrId === 'string' ? taskOrId : taskOrId?.id ?? taskOrId?.taskId;
  const task = id ? TASK_BY_ID.get(id) : null;
  if (task?.metadata?.groundTruth) return task.metadata.groundTruth;
  return { criticalFiles: [], relevantFiles: [], noiseFiles: [] };
}

function normPath(p) {
  return normalizeEvidencePath(p).toLowerCase();
}

function pathMatchesSet(candidate, targetList = []) {
  const norm = normPath(candidate);
  if (!norm) return false;
  return targetList.some((raw) => {
    const gt = normPath(raw);
    return gt && (norm === gt || norm.endsWith(`/${gt}`) || gt.endsWith(`/${norm}`));
  });
}

function extractTrialTokens(trial) {
  const tu = trial?.tokenUsage ?? trial?.telemetry?.tokenUsage ?? trial?.usage ?? null;
  const inputTokens = Math.max(0, Number(tu?.inputTokens ?? tu?.input ?? 0) || 0);
  const outputTokens = Math.max(0, Number(tu?.outputTokens ?? tu?.output ?? 0) || 0);
  const cacheReadTokens = Math.max(0, Number(tu?.cacheReadTokens ?? 0) || 0);
  const cacheWriteTokens = Math.max(0, Number(tu?.cacheWriteTokens ?? 0) || 0);
  const cacheEligibleInputTokens = Math.max(0, Number(tu?.cacheEligibleInputTokens ?? 0) || 0);
  const explicitTotal = Number(trial?.tokenCost ?? tu?.totalTokens ?? 0);
  const totalTokens =
    Number.isFinite(explicitTotal) && explicitTotal > 0 ? explicitTotal : inputTokens + outputTokens;
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    cacheEligibleInputTokens,
    totalTokens,
  };
}

function normalizeSupervisorCost(trial, aciMetrics, ledger) {
  const explicit = trial?.supervisorCost ?? aciMetrics?.supervisorCost ?? null;
  const ledgerCalls = Array.isArray(ledger?.supervisorCalls) ? ledger.supervisorCalls : [];
  if (explicit && typeof explicit === 'object' && Number(explicit.calls ?? 0) >= ledgerCalls.length) {
    const inputTokens = Math.max(0, Number(explicit.inputTokens ?? 0) || 0);
    const outputTokens = Math.max(0, Number(explicit.outputTokens ?? 0) || 0);
    const totalTokens = Math.max(0, Number(explicit.totalTokens ?? inputTokens + outputTokens) || 0);
    return {
      calls: Math.max(0, Number(explicit.calls ?? 0) || 0),
      inputTokens,
      outputTokens,
      totalTokens,
      durationMs: Math.max(0, Number(explicit.durationMs ?? 0) || 0),
    };
  }
  if (ledgerCalls.length > 0) {
    let inputTokens = 0;
    let outputTokens = 0;
    let totalTokens = 0;
    let durationMs = 0;
    for (const c of ledgerCalls) {
      const inp = Math.max(0, Number(c?.inputTokens ?? 0) || 0);
      const out = Math.max(0, Number(c?.outputTokens ?? 0) || 0);
      inputTokens += inp;
      outputTokens += out;
      totalTokens += Math.max(0, Number(c?.totalTokens ?? inp + out) || 0);
      durationMs += Math.max(0, Number(c?.durationMs ?? 0) || 0);
    }
    return { calls: ledgerCalls.length, inputTokens, outputTokens, totalTokens, durationMs };
  }
  const calls = Math.max(0, Number(aciMetrics?.supervisorCalls ?? trial?.supervisorCalls ?? 0) || 0);
  return { calls, inputTokens: 0, outputTokens: 0, totalTokens: 0, durationMs: 0 };
}

const CONTEXT_INSPECTION_TOOLS = new Set([
  'read_file',
  'read_blob',
  'inspect_repository',
  'glob',
  'grep',
]);

const NON_FILE_ADMISSION_TOOLS = new Set([
  'expand_context',
  'compute_file_digest',
  'query_symbol_graph',
  'run_diagnostics',
]);

function isContextAdmissionRecord(adm) {
  const p = String(adm?.path || '').trim();
  if (
    !p ||
    /^(?:bash|glob|grep|expand_context|query_symbol_graph|run_diagnostics|compute_file_digest):/i.test(
      p,
    )
  ) {
    return false;
  }
  if (NON_FILE_ADMISSION_TOOLS.has(p) || p === 'inspect_repository') return false;
  const tn = String(adm?.toolName || '').trim().toLowerCase();
  if (NON_FILE_ADMISSION_TOOLS.has(tn)) return false;
  if (!tn) return true;
  return CONTEXT_INSPECTION_TOOLS.has(tn);
}

function synthesizeAdmissionsFromTrial(trial, ledger, taskId) {
  if (Array.isArray(ledger?.admissions) && ledger.admissions.length > 0) {
    return ledger.admissions
      .filter(isContextAdmissionRecord)
      .map((a) => ({
        path: normalizeEvidencePath(a.path || ''),
        toolName: a.toolName ? String(a.toolName) : 'read_file',
        decision: String(a.decision || 'DIRECT').toUpperCase(),
        originalTokens: Math.max(0, Number(a.originalTokens ?? a.injectedTokens ?? 0) || 0),
        injectedTokens: Math.max(0, Number(a.injectedTokens ?? a.originalTokens ?? 0) || 0),
      }));
  }
  if (Array.isArray(trial?.admissions) && trial.admissions.length > 0) {
    return trial.admissions
      .filter(isContextAdmissionRecord)
      .map((a) => ({
        path: normalizeEvidencePath(a.path || ''),
        toolName: a.toolName ? String(a.toolName) : 'read_file',
        decision: String(a.decision || 'DIRECT').toUpperCase(),
        originalTokens: Math.max(0, Number(a.originalTokens ?? a.injectedTokens ?? 0) || 0),
        injectedTokens: Math.max(0, Number(a.injectedTokens ?? a.originalTokens ?? 0) || 0),
      }));
  }
  const taskObj = TASK_BY_ID.get(taskId);
  const fixtureFiles = taskObj?.fixture?.files ?? {};
  const estimateForPath = (rel) => {
    const norm = normalizeEvidencePath(rel);
    if (norm && Object.hasOwn(fixtureFiles, norm)) return estimateTokens(fixtureFiles[norm]);
    if (trial?.fileTokensMap && Object.hasOwn(trial.fileTokensMap, norm)) {
      return Math.max(1, Number(trial.fileTokensMap[norm]) || 100);
    }
    return 100;
  };
  const out = [];
  if (ledger && (ledger.kept?.length || ledger.compressed?.length || ledger.expanded?.length)) {
    for (const item of ledger.kept ?? []) {
      const tok = Math.max(0, Number(item.tokens ?? item.originalTokens ?? estimateForPath(item.path)) || 0);
      out.push({ path: normalizeEvidencePath(item.path || ''), toolName: 'read_file', decision: 'DIRECT', originalTokens: tok, injectedTokens: tok });
    }
    for (const item of ledger.compressed ?? []) {
      const orig = Math.max(0, Number(item.originalTokens ?? estimateForPath(item.path)) || 0);
      const stub = Math.max(0, Number(item.stubTokens ?? 25) || 25);
      out.push({ path: normalizeEvidencePath(item.path || ''), toolName: 'read_file', decision: 'DEFER', originalTokens: orig, injectedTokens: stub });
    }
    for (const item of ledger.expanded ?? []) {
      const tok = Math.max(0, Number(item.tokens ?? estimateForPath(item.path)) || 0);
      out.push({ path: normalizeEvidencePath(item.path || ''), toolName: 'read_file', decision: 'SUPPORTING', originalTokens: tok, injectedTokens: tok });
    }
    return out.filter((x) => x.path);
  }
  const trace = Array.isArray(trial?.toolCallTrace) ? trial.toolCallTrace : [];
  for (const call of trace) {
    if (call?.name === 'read_file' && call?.status !== 'failed' && call?.argsSummary) {
      const rel = normalizeEvidencePath(String(call.argsSummary).replace(/^read_file:\s*/i, '').trim());
      if (!rel) continue;
      const tok = estimateForPath(rel);
      out.push({ path: rel, toolName: 'read_file', decision: 'DIRECT', originalTokens: tok, injectedTokens: tok });
    }
  }
  const filesReadList = Array.isArray(trial?.readFiles)
    ? trial.readFiles
    : Array.isArray(trial?.reasoningMetrics?.filesRead)
      ? trial.reasoningMetrics.filesRead
      : [];
  if (!out.length && filesReadList.length > 0) {
    for (const rel of filesReadList) {
      const norm = normalizeEvidencePath(rel);
      if (!norm) continue;
      const tok = estimateForPath(norm);
      out.push({ path: norm, toolName: 'read_file', decision: 'DIRECT', originalTokens: tok, injectedTokens: tok });
    }
  }
  return out;
}

function inferArmFromProfile(rawProfile) {
  const p = String(rawProfile ?? '').trim();
  if (!p) return null;
  if (p === 'aci_25' || p === 'full_aci') return 'D';
  if (p === 'retrieval_supervisor') return 'C';
  if (p === 'deterministic_progressive') return 'B';
  if (p === 'raw_full') return 'A';
  return null;
}

/**
 * Computes the Wilson score 95% (or custom z) binomial confidence interval.
 */
export function computeWilson95CI(successes, total, z = 1.96) {
  const n = Number(total);
  if (!Number.isFinite(n) || n <= 0) {
    return { rate: 0, lower: 0, upper: 0, ci95HalfWidth: 0 };
  }
  const s = Math.max(0, Math.min(n, Number(successes) || 0));
  const zVal = Number.isFinite(Number(z)) && Number(z) > 0 ? Number(z) : 1.96;
  const p = s / n;
  const z2 = zVal * zVal;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const margin = (zVal * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  const lower = round4(Math.max(0, center - margin));
  const upper = round4(Math.min(1, center + margin));
  return {
    rate: round4(p),
    lower,
    upper,
    ci95HalfWidth: round4((upper - lower) / 2),
  };
}

function normalizeGovernanceTrial(raw) {
  const trial = raw && typeof raw === 'object' ? raw : {};
  const ev = trial?.judge?.evidence ?? trial?.evidence ?? {};
  const rm = trial?.reasoningMetrics ?? trial?.telemetry?.reasoningMetrics ?? {};
  const aciMetrics = trial?.aciMetrics ?? rm?.aciMetrics ?? {};
  const ledger = trial?.ledger ?? aciMetrics?.ledger ?? null;
  const taskId = String(trial.taskId ?? ev?.taskId ?? 'unknown');
  const rawProfile = trial.aciProfile ?? aciMetrics?.aciProfile ?? null;
  const arm =
    String(trial.arm ?? inferArmFromProfile(rawProfile) ?? 'A')
      .trim()
      .toUpperCase() || 'A';
  const explicitRep =
    trial.rep !== undefined && trial.rep !== null && Number.isInteger(Number(trial.rep))
      ? Number(trial.rep)
      : null;

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
  const tokens = extractTrialTokens(trial);
  const durationMs = Math.max(0, Number(trial.durationMs ?? trial.wallMs ?? 0) || 0);

  const gt =
    trial.groundTruth && typeof trial.groundTruth === 'object'
      ? {
          criticalFiles: Array.isArray(trial.groundTruth.criticalFiles) ? trial.groundTruth.criticalFiles : [],
          relevantFiles: Array.isArray(trial.groundTruth.relevantFiles) ? trial.groundTruth.relevantFiles : [],
          noiseFiles: Array.isArray(trial.groundTruth.noiseFiles) ? trial.groundTruth.noiseFiles : [],
        }
      : resolveAciTaskGroundTruth(taskId);

  const criticalSet = [...new Set(gt.criticalFiles.map(normPath).filter(Boolean))];
  const relevantSet = [...new Set([...gt.relevantFiles, ...gt.criticalFiles].map(normPath).filter(Boolean))];

  const admissions = synthesizeAdmissionsFromTrial(trial, ledger, taskId);
  const recoveries = Array.isArray(ledger?.recoveries)
    ? ledger.recoveries
    : Array.isArray(trial?.recoveries)
      ? trial.recoveries
      : [];

  const activePaths = [];
  const nonIrrelevantPaths = [];
  const discoveredPaths = [];
  const irrelevantPaths = [];

  let admissionOriginalTokens = 0;
  let admissionInjectedTokens = 0;
  let usefulInjectedTokens = 0;
  let totalInjectedTokens = 0;

  for (const adm of admissions) {
    if (!adm.path) continue;
    discoveredPaths.push(adm.path);
    admissionOriginalTokens += adm.originalTokens;
    admissionInjectedTokens += adm.injectedTokens;
    totalInjectedTokens += adm.injectedTokens;
    if (adm.decision === 'IRRELEVANT') {
      irrelevantPaths.push(adm.path);
    } else {
      nonIrrelevantPaths.push(adm.path);
      if (pathMatchesSet(adm.path, relevantSet)) {
        usefulInjectedTokens += adm.injectedTokens;
      }
      if (adm.decision === 'DIRECT' || adm.decision === 'SUPPORTING') {
        activePaths.push(adm.path);
      }
    }
  }

  for (const rec of recoveries) {
    const p = normalizeEvidencePath(rec?.path || '');
    if (!p) continue;
    discoveredPaths.push(p);
    if (rec?.verified !== false) {
      activePaths.push(p);
      nonIrrelevantPaths.push(p);
      const tok = Math.max(0, Number(rec?.tokensRestored ?? 0) || 0);
      totalInjectedTokens += tok;
      if (pathMatchesSet(p, relevantSet)) usefulInjectedTokens += tok;
    }
  }

  for (const d of ledger?.discovered ?? []) {
    if (d?.path) discoveredPaths.push(normalizeEvidencePath(d.path));
  }
  for (const f of rm?.rootCauseFilesReadBeforeEdit ?? []) {
    if (f) {
      discoveredPaths.push(normalizeEvidencePath(f));
      if (!admissions.length) {
        activePaths.push(normalizeEvidencePath(f));
        nonIrrelevantPaths.push(normalizeEvidencePath(f));
      }
    }
  }

  // Recall calculations against groundTruth.criticalFiles
  let activeRecall = 0;
  let discoveryRecall = 0;
  let falselyFilteredCriticalCount = 0;
  if (criticalSet.length > 0) {
    if (admissions.length > 0 || activePaths.length > 0 || recoveries.length > 0 || irrelevantPaths.length > 0) {
      const activeMatched = criticalSet.filter((cf) => pathMatchesSet(cf, activePaths)).length;
      const discoveryMatched = criticalSet.filter((cf) => pathMatchesSet(cf, discoveredPaths)).length;
      falselyFilteredCriticalCount = criticalSet.filter(
        (cf) => pathMatchesSet(cf, irrelevantPaths) && !pathMatchesSet(cf, activePaths),
      ).length;
      activeRecall = round4(activeMatched / criticalSet.length);
      discoveryRecall = round4(discoveryMatched / criticalSet.length);
    } else if (trial.criticalContextRecall != null && Number.isFinite(Number(trial.criticalContextRecall))) {
      activeRecall = round4(Math.max(0, Math.min(1, Number(trial.criticalContextRecall))));
      discoveryRecall = activeRecall;
    } else if (aciMetrics?.criticalContextRecall != null && Number.isFinite(Number(aciMetrics.criticalContextRecall))) {
      activeRecall = round4(Math.max(0, Math.min(1, Number(aciMetrics.criticalContextRecall))));
      discoveryRecall = activeRecall;
    }
  } else {
    activeRecall = 1;
    discoveryRecall = 1;
  }

  // Context precision: relevant non-IRRELEVANT unique paths / total non-IRRELEVANT unique paths
  const uniqueNonIrrelevant = [...new Set(nonIrrelevantPaths.map(normPath).filter(Boolean))];
  const relevantNonIrrelevant = uniqueNonIrrelevant.filter((p) => pathMatchesSet(p, relevantSet)).length;
  const contextPrecision =
    uniqueNonIrrelevant.length > 0
      ? round4(relevantNonIrrelevant / uniqueNonIrrelevant.length)
      : trial.contextPrecision != null && Number.isFinite(Number(trial.contextPrecision))
        ? round4(Math.max(0, Math.min(1, Number(trial.contextPrecision))))
        : activeRecall === 1
          ? 1
          : 0;

  const usefulTokenRatio =
    totalInjectedTokens > 0
      ? round4(Math.min(1, usefulInjectedTokens / totalInjectedTokens))
      : trial.usefulTokenRatio != null && Number.isFinite(Number(trial.usefulTokenRatio))
        ? round4(Math.max(0, Math.min(1, Number(trial.usefulTokenRatio))))
        : contextPrecision;

  const supervisorCost = normalizeSupervisorCost(trial, aciMetrics, ledger);

  const recStatsSource = trial.recoveryStats ?? aciMetrics?.recoveryStats ?? null;
  const traceExpandCount = Array.isArray(trial?.toolCallTrace)
    ? trial.toolCallTrace.filter((c) => c?.name === 'expand_context').length
    : 0;
  const expandAttempts = Math.max(
    recoveries.length,
    Number(recStatsSource?.expandAttempts ?? 0) || 0,
    traceExpandCount,
  );
  const hashVerified = Math.max(
    recoveries.filter((r) => r?.verified !== false).length,
    Number(recStatsSource?.hashVerified ?? aciMetrics?.hashVerifiedRestores ?? 0) || 0,
  );
  const totalRestores = Math.max(
    hashVerified,
    expandAttempts,
    Number(aciMetrics?.restoredCount ?? 0) || 0,
  );

  const eligibleInputTokens =
    tokens.cacheEligibleInputTokens > 0 ? tokens.cacheEligibleInputTokens : tokens.inputTokens;
  const explicitCacheHit =
    typeof trial.cacheHitRate === 'number' && Number.isFinite(trial.cacheHitRate)
      ? round4(Math.max(0, Math.min(1, trial.cacheHitRate)))
      : null;
  const sseCacheReported = Boolean(
    trial.sseCacheReported ?? (tokens.cacheReadTokens > 0 || explicitCacheHit !== null),
  );
  const cacheHitRate =
    eligibleInputTokens > 0 && tokens.cacheReadTokens > 0
      ? round4(Math.min(1, tokens.cacheReadTokens / eligibleInputTokens))
      : explicitCacheHit ?? 0;

  const failureCategory = passed
    ? 'none'
    : String(trial.failureCategory ?? ev?.failureCategory ?? (status === 'timeout' ? 'timeout' : 'failed'));
  const attribution = passed
    ? FAILURE_ATTRIBUTIONS.NONE
    : classifyAutonomousReasoningAttribution({
        ...trial,
        passed,
        status,
        criticalContextRecall: activeRecall,
        failureCategory,
        evidence: ev,
      });

  const ledgerPartialCount = recoveries.filter(
    (r) =>
      r?.partial === true ||
      ['symbol', 'lines', 'outline', 'hunk'].includes(String(r?.mode || '').toLowerCase()),
  ).length;
  const ledgerRecoverySaved = recoveries.reduce(
    (s, r) => s + Math.max(0, Number(r?.tokensSaved ?? 0) || 0),
    0,
  );
  const ledgerCompressed = Array.isArray(ledger?.compressed) ? ledger.compressed : [];
  const ledgerSupersededItems = ledgerCompressed.filter(
    (c) => c?.superseded === true || /superseded/i.test(String(c?.reason || '')),
  );
  const ledgerSupersededSaved = ledgerSupersededItems.reduce(
    (s, c) => s + Math.max(0, Number(c?.tokensSaved ?? 0) || 0),
    0,
  );

  const supersededEvictions = Math.max(
    0,
    Math.trunc(
      Number(
        aciMetrics?.supersededEvictions ??
          trial?.supersededEvictions ??
          ledger?.supersededEvictions ??
          0,
      ) || 0,
    ),
    ledgerSupersededItems.length,
  );
  const supersededTokensSaved = Math.max(
    0,
    Math.trunc(
      Number(
        aciMetrics?.supersededTokensSaved ??
          trial?.supersededTokensSaved ??
          ledger?.supersededTokensSaved ??
          0,
      ) || 0,
    ),
    ledgerSupersededSaved,
  );
  const partialRecoveries = Math.max(
    0,
    Math.trunc(
      Number(
        aciMetrics?.partialRecoveries ??
          recStatsSource?.partialRecoveries ??
          trial?.partialRecoveries ??
          ledger?.partialRecoveries ??
          0,
      ) || 0,
    ),
    ledgerPartialCount,
  );
  const recoveryTokensSaved = Math.max(
    0,
    Math.trunc(
      Number(
        aciMetrics?.recoveryTokensSaved ??
          recStatsSource?.recoveryTokensSaved ??
          trial?.recoveryTokensSaved ??
          ledger?.recoveryTokensSaved ??
          0,
      ) || 0,
    ),
    ledgerRecoverySaved,
  );
  const rawAntiThrashing =
    rm?.antiThrashingTriggered ??
    aciMetrics?.antiThrashingTriggered ??
    trial?.antiThrashingTriggered ??
    0;
  const antiThrashingTriggered =
    typeof rawAntiThrashing === 'boolean'
      ? rawAntiThrashing
        ? 1
        : 0
      : Math.max(0, Math.trunc(Number(rawAntiThrashing) || 0));

  const rawDecSource =
    aciMetrics?.admissionDecisions ??
    aciMetrics?.decisions ??
    trial?.decisions ??
    ledger?.decisionCounts ??
    null;
  const decisions = { DIRECT: 0, SUPPORTING: 0, DEFER: 0, DUPLICATE: 0, IRRELEVANT: 0 };
  const hasExplicitDecisions =
    rawDecSource &&
    typeof rawDecSource === 'object' &&
    ['DIRECT', 'SUPPORTING', 'DEFER', 'DUPLICATE', 'IRRELEVANT'].some(
      (k) => Number(rawDecSource[k] || 0) > 0,
    );
  if (hasExplicitDecisions) {
    for (const k of Object.keys(decisions)) {
      decisions[k] = Math.max(0, Math.trunc(Number(rawDecSource[k] ?? 0) || 0));
    }
  } else {
    for (const adm of admissions) {
      const k = String(adm?.decision || '').toUpperCase();
      if (Object.hasOwn(decisions, k)) decisions[k] += 1;
    }
  }

  return {
    taskId,
    arm,
    rep: explicitRep,
    aciProfile: rawProfile ? normalizeAciProfileName(rawProfile) : ACI_ARM_PROFILES[arm]?.aciProfile ?? null,
    status,
    passed,
    criticalContextRecall: activeRecall,
    discoveryRecall,
    contextPrecision,
    falseNegativeRate: round4(1 - activeRecall),
    falselyFilteredCriticalCount,
    usefulTokenRatio,
    usefulInjectedTokens,
    totalInjectedTokens,
    admissionOriginalTokens,
    admissionInjectedTokens,
    cacheHitRate,
    sseCacheReported,
    eligibleInputTokens,
    tokens,
    tokenCost: tokens.totalTokens,
    durationMs,
    supervisorCost,
    expandAttempts,
    hashVerified,
    totalRestores,
    epochTransitions: Math.max(0, Number(aciMetrics?.epochTransitions ?? trial?.epochTransitions ?? 0) || 0),
    offloadedCount: Math.max(0, Number(aciMetrics?.offloadedCount ?? trial?.offloadedCount ?? 0) || 0),
    savedTokens: Math.max(0, Number(aciMetrics?.savedTokens ?? trial?.savedTokens ?? 0) || 0),
    supersededEvictions,
    supersededTokensSaved,
    partialRecoveries,
    recoveryTokensSaved,
    antiThrashingTriggered,
    decisions,
    failureCategory,
    attribution,
  };
}

function assignPairingKeys(normalizedTrials) {
  const seqCounters = new Map();
  return normalizedTrials.map((t) => {
    let pairRep = t.rep;
    if (pairRep === null || pairRep === undefined) {
      const k = `${t.arm}::${t.taskId}`;
      pairRep = seqCounters.get(k) ?? 0;
      seqCounters.set(k, pairRep + 1);
    }
    return {
      ...t,
      rep: pairRep,
      _pairKey: `${t.taskId}::${pairRep}`,
    };
  });
}

function computePairedPassTokenStats(armTrials, baselinePassedByPairKey, isBaselineArm) {
  if (isBaselineArm) {
    const passedCount = armTrials.filter((t) => t.passed).length;
    return {
      pairedPassCount: passedCount,
      pairedPassTokenReduction: passedCount > 0 ? 0 : null,
    };
  }
  if (!baselinePassedByPairKey || baselinePassedByPairKey.size === 0) {
    return { pairedPassCount: 0, pairedPassTokenReduction: null };
  }
  let baseSum = 0;
  let armSum = 0;
  let pairedPassCount = 0;
  for (const t of armTrials) {
    if (!t.passed) continue;
    const baseTokens = baselinePassedByPairKey.get(t._pairKey);
    if (baseTokens === undefined) continue;
    baseSum += baseTokens;
    armSum += t.tokenCost;
    pairedPassCount += 1;
  }
  if (pairedPassCount === 0 || baseSum <= 0) {
    return { pairedPassCount: 0, pairedPassTokenReduction: null };
  }
  return {
    pairedPassCount,
    pairedPassTokenReduction: round4((baseSum - armSum) / baseSum),
  };
}

function aggregateArmMetrics(
  armTrials,
  baselineMeanTokens = null,
  { baselinePassedByPairKey = null, isBaselineArm = false } = {},
) {
  const totalTrials = armTrials.length;
  const passedList = armTrials.filter((t) => t.passed);
  const passedTrials = passedList.length;
  const failedTrials = totalTrials - passedTrials;
  const passRateCI = computeWilson95CI(passedTrials, totalTrials);

  const meanActiveRecall = totalTrials
    ? round4(armTrials.reduce((s, t) => s + t.criticalContextRecall, 0) / totalTrials)
    : 0;
  const meanDiscoveryRecall = totalTrials
    ? round4(armTrials.reduce((s, t) => s + t.discoveryRecall, 0) / totalTrials)
    : 0;
  const meanContextPrecision = totalTrials
    ? round4(armTrials.reduce((s, t) => s + t.contextPrecision, 0) / totalTrials)
    : 0;
  const falselyMarkedIrrelevantCount = armTrials.reduce(
    (s, t) => s + t.falselyFilteredCriticalCount,
    0,
  );

  const sumUsefulTok = armTrials.reduce((s, t) => s + t.usefulInjectedTokens, 0);
  const sumInjectedTok = armTrials.reduce((s, t) => s + t.totalInjectedTokens, 0);
  const usefulTokenRatio =
    sumInjectedTok > 0
      ? round4(Math.min(1, sumUsefulTok / sumInjectedTok))
      : totalTrials
        ? round4(armTrials.reduce((s, t) => s + t.usefulTokenRatio, 0) / totalTrials)
        : 0;

  const sumAdmissionOrig = armTrials.reduce((s, t) => s + t.admissionOriginalTokens, 0);
  const sumAdmissionInj = armTrials.reduce((s, t) => s + t.admissionInjectedTokens, 0);
  const admissionTokenReduction =
    sumAdmissionOrig > 0 ? round4((sumAdmissionOrig - sumAdmissionInj) / sumAdmissionOrig) : 0;

  const totalTokens = armTrials.reduce((s, t) => s + t.tokenCost, 0);
  const totalInputTokens = armTrials.reduce((s, t) => s + t.tokens.inputTokens, 0);
  const totalOutputTokens = armTrials.reduce((s, t) => s + t.tokens.outputTokens, 0);
  const totalCacheReadTokens = armTrials.reduce((s, t) => s + t.tokens.cacheReadTokens, 0);
  const totalCacheWriteTokens = armTrials.reduce((s, t) => s + t.tokens.cacheWriteTokens, 0);
  const totalEligibleInputTokens = armTrials.reduce((s, t) => s + t.eligibleInputTokens, 0);
  const meanTokens = totalTrials ? Math.round(totalTokens / totalTrials) : 0;
  const tokensPerCompletedPass = passedTrials > 0 ? Math.round(totalTokens / passedTrials) : null;
  const meanTokensOnPassedTrials =
    passedTrials > 0
      ? Math.round(passedList.reduce((s, t) => s + t.tokenCost, 0) / passedTrials)
      : null;

  const tokenReduction =
    baselineMeanTokens && baselineMeanTokens > 0
      ? round4((baselineMeanTokens - meanTokens) / baselineMeanTokens)
      : 0;
  const { pairedPassCount, pairedPassTokenReduction } = computePairedPassTokenStats(
    armTrials,
    baselinePassedByPairKey,
    isBaselineArm,
  );

  const overallCacheHitRate =
    totalEligibleInputTokens > 0 && totalCacheReadTokens > 0
      ? round4(Math.min(1, totalCacheReadTokens / totalEligibleInputTokens))
      : totalTrials && armTrials.some((t) => t.cacheHitRate > 0)
        ? round4(armTrials.reduce((s, t) => s + t.cacheHitRate, 0) / totalTrials)
        : 0;

  const sseTrials = armTrials.filter((t) => t.sseCacheReported);
  const sseEligible = sseTrials.reduce((s, t) => s + t.eligibleInputTokens, 0);
  const sseCacheRead = sseTrials.reduce((s, t) => s + t.tokens.cacheReadTokens, 0);
  const sseReportedRate =
    sseEligible > 0 && sseCacheRead > 0
      ? round4(Math.min(1, sseCacheRead / sseEligible))
      : sseTrials.length && sseTrials.some((t) => t.cacheHitRate > 0)
        ? round4(sseTrials.reduce((s, t) => s + t.cacheHitRate, 0) / sseTrials.length)
        : 0;

  const supCalls = armTrials.reduce((s, t) => s + t.supervisorCost.calls, 0);
  const supIn = armTrials.reduce((s, t) => s + t.supervisorCost.inputTokens, 0);
  const supOut = armTrials.reduce((s, t) => s + t.supervisorCost.outputTokens, 0);
  const supTotal = armTrials.reduce((s, t) => s + t.supervisorCost.totalTokens, 0);
  const supMs = armTrials.reduce((s, t) => s + t.supervisorCost.durationMs, 0);
  const supervisorCost = {
    calls: supCalls,
    inputTokens: supIn,
    outputTokens: supOut,
    totalTokens: supTotal,
    durationMs: supMs,
    tokenShareOfTotal: totalTokens > 0 ? round4(supTotal / totalTokens) : 0,
  };

  const expandAttempts = armTrials.reduce((s, t) => s + t.expandAttempts, 0);
  const hashVerified = armTrials.reduce((s, t) => s + t.hashVerified, 0);
  const totalRestores = armTrials.reduce((s, t) => s + t.totalRestores, 0);
  const recoveryTrials = armTrials.filter((t) => t.expandAttempts > 0 || t.totalRestores > 0);
  const trialsWithRecovery = recoveryTrials.length;
  const passedWithRecovery = recoveryTrials.filter((t) => t.passed).length;
  const recoverySuccessRate = expandAttempts > 0 ? round4(hashVerified / Math.max(1, expandAttempts)) : 0;
  const recoveryAssistedPassRate = trialsWithRecovery > 0 ? round4(passedWithRecovery / trialsWithRecovery) : 0;

  const totalDurationMs = armTrials.reduce((s, t) => s + t.durationMs, 0);
  const supersededEvictions = armTrials.reduce((s, t) => s + (t.supersededEvictions || 0), 0);
  const supersededTokensSaved = armTrials.reduce((s, t) => s + (t.supersededTokensSaved || 0), 0);
  const partialRecoveries = armTrials.reduce((s, t) => s + (t.partialRecoveries || 0), 0);
  const recoveryTokensSaved = armTrials.reduce((s, t) => s + (t.recoveryTokensSaved || 0), 0);
  const antiThrashingTriggered = armTrials.reduce((s, t) => s + (t.antiThrashingTriggered || 0), 0);
  const decisions = { DIRECT: 0, SUPPORTING: 0, DEFER: 0, DUPLICATE: 0, IRRELEVANT: 0 };
  for (const t of armTrials) {
    if (!t.decisions || typeof t.decisions !== 'object') continue;
    for (const k of Object.keys(decisions)) {
      decisions[k] += Math.max(0, Math.trunc(Number(t.decisions[k] ?? 0) || 0));
    }
  }
  const attributionCounts = {
    [FAILURE_ATTRIBUTIONS.TOOL_MECHANISM]: 0,
    [FAILURE_ATTRIBUTIONS.MODEL_CAPABILITY]: 0,
    [FAILURE_ATTRIBUTIONS.RUNTIME_RELIABILITY]: 0,
    [FAILURE_ATTRIBUTIONS.CONTEXT_RETRIEVAL]: 0,
    [FAILURE_ATTRIBUTIONS.NONE]: 0,
  };
  for (const t of armTrials) {
    attributionCounts[t.attribution] = (attributionCounts[t.attribution] ?? 0) + 1;
  }

  return {
    totalTrials,
    passedTrials,
    failedTrials,
    passRateCI,
    // Exact 9 Governance Metrics:
    criticalContextRecall: meanActiveRecall,
    contextPrecision: meanContextPrecision,
    falseNegativeRate: round4(1 - meanActiveRecall),
    usefulTokenRatio,
    tokenReduction,
    tokensPerCompletedPass,
    meanTokensOnPassedTrials,
    pairedPassTokenReduction,
    pairedPassCount,
    cacheHitRate: overallCacheHitRate,
    supervisorCost,
    recoverySuccessRate,
    finalTaskSuccessRate: totalTrials ? round4(passedTrials / totalTrials) : 0,
    // 2.6 Trajectory Eviction, Partial Recovery, Anti-Thrashing & 5-Level Decisions:
    supersededEvictions,
    supersededTokensSaved,
    partialRecoveries,
    recoveryTokensSaved,
    antiThrashingTriggered,
    decisions,
    // Detailed Governance Breakdowns:
    criticalContextRecallDetail: {
      activeRecall: meanActiveRecall,
      discoveryRecall: meanDiscoveryRecall,
    },
    contextPrecisionDetail: {
      filePrecision: meanContextPrecision,
      tokenPrecision: usefulTokenRatio,
    },
    falseNegativeDetail: {
      rate: round4(1 - meanActiveRecall),
      falselyMarkedIrrelevantCount,
    },
    falselyMarkedIrrelevantCount,
    admissionTokenReduction,
    cacheHitRateDetail: {
      overall: overallCacheHitRate,
      sseReportedRate,
      sseReportedTrials: sseTrials.length,
      cacheReadTokens: totalCacheReadTokens,
      eligibleInputTokens: totalEligibleInputTokens,
    },
    recoveryStats: {
      expandAttempts,
      hashVerified,
      totalRestores,
      partialRecoveries,
      recoveryTokensSaved,
      trialsWithRecovery,
      recoveryAssistedPassRate,
    },
    tokenBreakdown: {
      totalTokens,
      meanTokens,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      cacheReadTokens: totalCacheReadTokens,
      cacheWriteTokens: totalCacheWriteTokens,
      eligibleInputTokens: totalEligibleInputTokens,
    },
    dtocStats: {
      epochTransitions: armTrials.reduce((s, t) => s + t.epochTransitions, 0),
      offloadedCount: armTrials.reduce((s, t) => s + t.offloadedCount, 0),
      savedTokens: armTrials.reduce((s, t) => s + t.savedTokens, 0),
      supersededEvictions,
      supersededTokensSaved,
    },
    meanDurationMs: totalTrials ? Math.round(totalDurationMs / totalTrials) : 0,
    attributionCounts,
  };
}

/**
 * Computes all 9 ACI Governance Metrics (plus Wilson 95% CI & success-normalized
 * token efficiency metrics) per arm and per task while retaining 100% of
 * failed, timed-out, and cancelled trials.
 */
export function computeAciGovernanceMetrics(trials = [], { baselineArm = 'A' } = {}) {
  const rawList = Array.isArray(trials) ? trials : [];
  const normalizedWithPairs = assignPairingKeys(rawList.map(normalizeGovernanceTrial));
  const normBaseArm = String(baselineArm || 'A').trim().toUpperCase() || 'A';

  const armOrder = ['A', 'B', 'C', 'D'];
  const presentArms = [...new Set(normalizedWithPairs.map((t) => t.arm))];
  presentArms.sort((a, b) => {
    const ia = armOrder.indexOf(a);
    const ib = armOrder.indexOf(b);
    if (ia !== -1 && ib !== -1) return ia - ib;
    if (ia !== -1) return -1;
    if (ib !== -1) return 1;
    return a.localeCompare(b);
  });

  const baseTrials = normalizedWithPairs.filter((t) => t.arm === normBaseArm);
  const baseMeanTokens = baseTrials.length
    ? Math.round(baseTrials.reduce((s, t) => s + t.tokenCost, 0) / baseTrials.length)
    : null;
  const baselinePassedByPairKey = new Map();
  for (const bt of baseTrials) {
    if (bt.passed) baselinePassedByPairKey.set(bt._pairKey, bt.tokenCost);
  }

  const byArm = {};
  for (const arm of presentArms) {
    const armTrials = normalizedWithPairs.filter((t) => t.arm === arm);
    const isBase = arm === normBaseArm;
    byArm[arm] = {
      arm,
      ...aggregateArmMetrics(armTrials, isBase ? null : baseMeanTokens, {
        baselinePassedByPairKey,
        isBaselineArm: isBase,
      }),
    };
    if (isBase) {
      byArm[arm].tokenReduction = 0;
    }
  }

  const taskIds = [...new Set(normalizedWithPairs.map((t) => t.taskId))];
  const byTask = {};
  for (const taskId of taskIds) {
    const taskTrials = normalizedWithPairs.filter((t) => t.taskId === taskId);
    const taskBaseTrials = taskTrials.filter((t) => t.arm === normBaseArm);
    const taskBaseMean = taskBaseTrials.length
      ? Math.round(taskBaseTrials.reduce((s, t) => s + t.tokenCost, 0) / taskBaseTrials.length)
      : null;
    const taskBasePassedByPairKey = new Map();
    for (const bt of taskBaseTrials) {
      if (bt.passed) taskBasePassedByPairKey.set(bt._pairKey, bt.tokenCost);
    }
    const taskByArm = {};
    for (const arm of presentArms) {
      const sub = taskTrials.filter((t) => t.arm === arm);
      if (!sub.length) continue;
      const isBase = arm === normBaseArm;
      taskByArm[arm] = {
        arm,
        ...aggregateArmMetrics(sub, isBase ? null : taskBaseMean, {
          baselinePassedByPairKey: taskBasePassedByPairKey,
          isBaselineArm: isBase,
        }),
      };
      if (isBase) taskByArm[arm].tokenReduction = 0;
    }
    byTask[taskId] = {
      taskId,
      totalTrials: taskTrials.length,
      passedTrials: taskTrials.filter((t) => t.passed).length,
      byArm: taskByArm,
    };
  }

  const totalTrials = normalizedWithPairs.length;
  const passedTrials = normalizedWithPairs.filter((t) => t.passed).length;
  const cleanTrials = normalizedWithPairs.map(({ _pairKey, ...rest }) => rest);

  return {
    benchmarkId: ACI_GOVERNANCE_BENCHMARK_ID,
    version: VERSION,
    baselineArm: normBaseArm,
    totalTrials,
    passedTrials,
    failedTrials: totalTrials - passedTrials,
    arms: presentArms,
    byArm,
    byTask,
    trials: cleanTrials,
  };
}

// ---------------------------------------------------------------------------
// Paper Table Exporters (Markdown & LaTeX)
// ---------------------------------------------------------------------------

function resolveMetricsRoot(summaryOrMetrics) {
  if (!summaryOrMetrics || typeof summaryOrMetrics !== 'object') {
    return { metrics: { arms: [], byArm: {}, byTask: {}, baselineArm: 'A' }, armProfiles: {} };
  }
  const metrics = summaryOrMetrics.metrics ?? summaryOrMetrics;
  const armProfiles = summaryOrMetrics.armProfiles ?? {};
  return {
    benchmarkId: summaryOrMetrics.benchmarkId ?? metrics.benchmarkId ?? ACI_GOVERNANCE_BENCHMARK_ID,
    mode: summaryOrMetrics.mode ?? 'unknown',
    suite: summaryOrMetrics.suite ?? 'aci',
    sandboxBackend: summaryOrMetrics.sandboxBackend ?? 'unknown',
    metrics,
    armProfiles,
  };
}

function fmtPct(ratio, digits = 1) {
  if (ratio === null || ratio === undefined || !Number.isFinite(Number(ratio))) return 'N/A';
  return `${(Number(ratio) * 100).toFixed(digits)}%`;
}

function fmtInt(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return 'N/A';
  return Math.round(Number(value)).toLocaleString('en-US');
}

function fmtCI(ci) {
  if (!ci || !Number.isFinite(Number(ci.rate))) return 'N/A';
  return `${fmtPct(ci.rate)} [${fmtPct(ci.lower)}, ${fmtPct(ci.upper)}]`;
}

function resolveArmDisplayProfile(arm, armMetrics, armProfiles) {
  const fromProfiles = armProfiles?.[arm]?.aciProfile;
  if (fromProfiles) return fromProfiles;
  if (armMetrics?.aciProfile) return armMetrics.aciProfile;
  return ACI_ARM_PROFILES[arm]?.aciProfile ?? arm;
}

function escapeLatex(text) {
  return String(text ?? '')
    .replaceAll('\\', '\\textbackslash{}')
    .replaceAll('&', '\\&')
    .replaceAll('%', '\\%')
    .replaceAll('$', '\\$')
    .replaceAll('#', '\\#')
    .replaceAll('_', '\\_')
    .replaceAll('{', '\\{')
    .replaceAll('}', '\\}');
}

/**
 * Formats benchmark summary/metrics into Markdown tables ready for paper/report inclusion.
 */
export function exportPaperTablesMarkdown(summary) {
  const ctx = resolveMetricsRoot(summary);
  const m = ctx.metrics ?? {};
  const arms = Array.isArray(m.arms) ? m.arms : Object.keys(m.byArm ?? {});
  const byArm = m.byArm ?? {};
  const byTask = m.byTask ?? {};

  const lines = [
    `## ACI Governance Benchmark Summary (${ctx.benchmarkId}, suite=${ctx.suite}, mode=${ctx.mode}, sandbox=${ctx.sandboxBackend})`,
    '',
    '### Table 1: Overall Arm Comparison & Success-Normalized Efficiency',
    '',
    '| Arm | Profile | Pass (n/N) | Pass Rate (Wilson 95% CI) | Recall | Precision | Useful Tok | Mean Tok | Tok/Pass | Mean Passed Tok | Paired-Pass Tok Red | Cache Hit | Sup Tok | Recovery |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];

  for (const arm of arms) {
    const a = byArm[arm];
    if (!a) continue;
    const prof = resolveArmDisplayProfile(arm, a, ctx.armProfiles);
    const ci = a.passRateCI ?? computeWilson95CI(a.passedTrials, a.totalTrials);
    const pairedStr =
      a.pairedPassTokenReduction === null || a.pairedPassTokenReduction === undefined
        ? 'N/A'
        : `${fmtPct(a.pairedPassTokenReduction)} (n=${a.pairedPassCount ?? 0})`;
    lines.push(
      `| ${arm} | \`${prof}\` | ${a.passedTrials}/${a.totalTrials} | ${fmtCI(ci)} | ${fmtPct(a.criticalContextRecall)} | ${fmtPct(a.contextPrecision)} | ${fmtPct(a.usefulTokenRatio)} | ${fmtInt(a.tokenBreakdown?.meanTokens)} | ${fmtInt(a.tokensPerCompletedPass)} | ${fmtInt(a.meanTokensOnPassedTrials)} | ${pairedStr} | ${fmtPct(a.cacheHitRate)} | ${fmtInt(a.supervisorCost?.totalTokens)} | ${fmtPct(a.recoverySuccessRate)} |`,
    );
  }

  const taskIds = Object.keys(byTask);
  if (taskIds.length > 0) {
    lines.push(
      '',
      '### Table 2: Per-Task Breakdown',
      '',
      '| Task | Arm | Pass (n/N) | Mean Tok | Paired-Pass Tok Red | Recall | Precision | Cache Hit |',
      '| --- | --- | --- | --- | --- | --- | --- | --- |',
    );
    for (const taskId of taskIds) {
      const tEntry = byTask[taskId];
      for (const arm of arms) {
        const ta = tEntry?.byArm?.[arm];
        if (!ta) continue;
        const pairedStr =
          ta.pairedPassTokenReduction === null || ta.pairedPassTokenReduction === undefined
            ? 'N/A'
            : `${fmtPct(ta.pairedPassTokenReduction)} (n=${ta.pairedPassCount ?? 0})`;
        lines.push(
          `| \`${taskId}\` | ${arm} | ${ta.passedTrials}/${ta.totalTrials} | ${fmtInt(ta.tokenBreakdown?.meanTokens)} | ${pairedStr} | ${fmtPct(ta.criticalContextRecall)} | ${fmtPct(ta.contextPrecision)} | ${fmtPct(ta.cacheHitRate)} |`,
        );
      }
    }
  }

  if (arms.length > 0) {
    lines.push(
      '',
      '### Table 3: ACI 2.6 Trajectory Eviction, Partial Recovery & Admission Decisions',
      '',
      '| Arm | Superseded Evictions | Superseded Saved Tok | Partial Recoveries | Recovery Saved Tok | Anti-Thrashing | Decisions (D/S/Def/Dup/Irr) |',
      '| --- | --- | --- | --- | --- | --- | --- |',
    );
    for (const arm of arms) {
      const a = byArm[arm];
      if (!a) continue;
      const dec = a.decisions ?? {};
      const decStr = `${dec.DIRECT ?? 0}/${dec.SUPPORTING ?? 0}/${dec.DEFER ?? 0}/${dec.DUPLICATE ?? 0}/${dec.IRRELEVANT ?? 0}`;
      lines.push(
        `| ${arm} | ${fmtInt(a.supersededEvictions ?? 0)} | ${fmtInt(a.supersededTokensSaved ?? 0)} | ${fmtInt(a.partialRecoveries ?? 0)} | ${fmtInt(a.recoveryTokensSaved ?? 0)} | ${fmtInt(a.antiThrashingTriggered ?? 0)} | ${decStr} |`,
      );
    }
  }

  return lines.join('\n') + '\n';
}

/**
 * Formats benchmark summary/metrics into LaTeX booktabs tables ready for paper inclusion.
 */
export function exportPaperTablesLatex(summary) {
  const ctx = resolveMetricsRoot(summary);
  const m = ctx.metrics ?? {};
  const arms = Array.isArray(m.arms) ? m.arms : Object.keys(m.byArm ?? {});
  const byArm = m.byArm ?? {};

  const lines = [
    '% Auto-generated by Agent_US ACI Governance Evaluator',
    '\\begin{table}[htbp]',
    '\\centering',
    `\\caption{ACI Governance Comparison (${escapeLatex(ctx.benchmarkId)}, suite=${escapeLatex(ctx.suite)})}`,
    '\\label{tab:aci-governance-comparison}',
    '\\begin{tabular}{llrrrrrrr}',
    '\\toprule',
    'Arm & Profile & Pass & Pass Rate (Wilson 95\\% CI) & Recall & Precision & Mean Tok & Tok/Pass & Paired-Pass Red \\\\',
    '\\midrule',
  ];

  for (const arm of arms) {
    const a = byArm[arm];
    if (!a) continue;
    const prof = resolveArmDisplayProfile(arm, a, ctx.armProfiles);
    const ci = a.passRateCI ?? computeWilson95CI(a.passedTrials, a.totalTrials);
    const ciStr = `${fmtPct(ci.rate)} [${fmtPct(ci.lower)}, ${fmtPct(ci.upper)}]`;
    const pairedStr =
      a.pairedPassTokenReduction === null || a.pairedPassTokenReduction === undefined
        ? '--'
        : `${fmtPct(a.pairedPassTokenReduction)} (n=${a.pairedPassCount ?? 0})`;
    lines.push(
      `${escapeLatex(arm)} & \\texttt{${escapeLatex(prof)}} & ${a.passedTrials}/${a.totalTrials} & ${escapeLatex(ciStr)} & ${escapeLatex(fmtPct(a.criticalContextRecall))} & ${escapeLatex(fmtPct(a.contextPrecision))} & ${escapeLatex(fmtInt(a.tokenBreakdown?.meanTokens))} & ${escapeLatex(fmtInt(a.tokensPerCompletedPass))} & ${escapeLatex(pairedStr)} \\\\`,
    );
  }

  lines.push(
    '\\bottomrule',
    '\\end{tabular}',
    '\\end{table}',
  );

  return lines.join('\n') + '\n';
}
