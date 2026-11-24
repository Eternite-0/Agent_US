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

const RAW_ACI_TASKS = [
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
].map((raw) => {
  const baselineFileHashes = computeFileHashes(raw.fixture.files, [
    ...(raw.fixture.baselineTestFiles ?? []),
    ...Object.keys(raw.fixture.files).filter((p) =>
      ['SPEC.md', 'CONSTRAINTS.md', 'CONTRACT.json', 'fixtures/baseline-events.json'].includes(p) ||
      p === 'src/core/runtime-options.js' ||
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
  const resourceBudget = {
    maxSteps: Math.max(22, budgetPlan.maxSteps),
    maxTokens: Math.max(160_000, budgetPlan.estimatedTokens),
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
    category: 'aci-governance-2.4-s4',
    difficulty: 'hard',
    tags: ['benchmark', 'aci-governance', '2.4', 'stage-4', raw.area],
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
});

export const ACI_GOVERNANCE_DATASET = Object.freeze(RAW_ACI_TASKS);

export function createAciGovernanceDataset({
  sandbox = null,
  sandboxOptions = null,
  repoOverrides = null,
} = {}) {
  const datasetSandbox =
    sandbox ?? (sandboxOptions ? new BenchmarkSandbox(sandboxOptions) : getDefaultBenchmarkSandbox());
  return RAW_ACI_TASKS.map((task) => {
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

export async function materializeAciGovernanceRepos(rootDir, { tasks = RAW_ACI_TASKS } = {}) {
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

const TASK_BY_ID = new Map(RAW_ACI_TASKS.map((t) => [t.id, t]));

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

function isContextAdmissionRecord(adm) {
  const p = String(adm?.path || '').trim();
  if (!p || /^(?:bash|glob|grep|expand_context):/i.test(p)) return false;
  if (p === 'expand_context' || p === 'compute_file_digest') return false;
  const tn = String(adm?.toolName || '').trim().toLowerCase();
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

function normalizeGovernanceTrial(raw) {
  const trial = raw && typeof raw === 'object' ? raw : {};
  const ev = trial?.judge?.evidence ?? trial?.evidence ?? {};
  const rm = trial?.reasoningMetrics ?? trial?.telemetry?.reasoningMetrics ?? {};
  const aciMetrics = trial?.aciMetrics ?? rm?.aciMetrics ?? {};
  const ledger = trial?.ledger ?? aciMetrics?.ledger ?? null;
  const taskId = String(trial.taskId ?? ev?.taskId ?? 'unknown');
  const arm = String(trial.arm ?? 'A').trim().toUpperCase() || 'A';

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

  return {
    taskId,
    arm,
    aciProfile: trial.aciProfile ?? aciMetrics?.aciProfile ?? ACI_ARM_PROFILES[arm]?.aciProfile ?? null,
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
    failureCategory,
    attribution,
  };
}

function aggregateArmMetrics(armTrials, baselineMeanTokens = null) {
  const totalTrials = armTrials.length;
  const passedTrials = armTrials.filter((t) => t.passed).length;
  const failedTrials = totalTrials - passedTrials;

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

  const tokenReduction =
    baselineMeanTokens && baselineMeanTokens > 0
      ? round4((baselineMeanTokens - meanTokens) / baselineMeanTokens)
      : 0;

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
    // Exact 9 Governance Metrics:
    criticalContextRecall: meanActiveRecall,
    contextPrecision: meanContextPrecision,
    falseNegativeRate: round4(1 - meanActiveRecall),
    usefulTokenRatio,
    tokenReduction,
    cacheHitRate: overallCacheHitRate,
    supervisorCost,
    recoverySuccessRate,
    finalTaskSuccessRate: totalTrials ? round4(passedTrials / totalTrials) : 0,
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
    },
    meanDurationMs: totalTrials ? Math.round(totalDurationMs / totalTrials) : 0,
    attributionCounts,
  };
}

/**
 * Computes all 9 ACI Governance Metrics per arm and per task while retaining
 * 100% of failed, timed-out, and cancelled trials.
 */
export function computeAciGovernanceMetrics(trials = [], { baselineArm = 'A' } = {}) {
  const rawList = Array.isArray(trials) ? trials : [];
  const normalized = rawList.map(normalizeGovernanceTrial);
  const normBaseArm = String(baselineArm || 'A').trim().toUpperCase() || 'A';

  const armOrder = ['A', 'B', 'C', 'D'];
  const presentArms = [...new Set(normalized.map((t) => t.arm))];
  presentArms.sort((a, b) => {
    const ia = armOrder.indexOf(a);
    const ib = armOrder.indexOf(b);
    if (ia !== -1 && ib !== -1) return ia - ib;
    if (ia !== -1) return -1;
    if (ib !== -1) return 1;
    return a.localeCompare(b);
  });

  const baseTrials = normalized.filter((t) => t.arm === normBaseArm);
  const baseMeanTokens = baseTrials.length
    ? Math.round(baseTrials.reduce((s, t) => s + t.tokenCost, 0) / baseTrials.length)
    : null;

  const byArm = {};
  for (const arm of presentArms) {
    const armTrials = normalized.filter((t) => t.arm === arm);
    byArm[arm] = {
      arm,
      ...aggregateArmMetrics(armTrials, arm === normBaseArm ? null : baseMeanTokens),
    };
    if (arm === normBaseArm) {
      byArm[arm].tokenReduction = 0;
    }
  }

  const taskIds = [...new Set(normalized.map((t) => t.taskId))];
  const byTask = {};
  for (const taskId of taskIds) {
    const taskTrials = normalized.filter((t) => t.taskId === taskId);
    const taskBaseTrials = taskTrials.filter((t) => t.arm === normBaseArm);
    const taskBaseMean = taskBaseTrials.length
      ? Math.round(taskBaseTrials.reduce((s, t) => s + t.tokenCost, 0) / taskBaseTrials.length)
      : null;
    const taskByArm = {};
    for (const arm of presentArms) {
      const sub = taskTrials.filter((t) => t.arm === arm);
      if (!sub.length) continue;
      taskByArm[arm] = {
        arm,
        ...aggregateArmMetrics(sub, arm === normBaseArm ? null : taskBaseMean),
      };
      if (arm === normBaseArm) taskByArm[arm].tokenReduction = 0;
    }
    byTask[taskId] = {
      taskId,
      totalTrials: taskTrials.length,
      passedTrials: taskTrials.filter((t) => t.passed).length,
      byArm: taskByArm,
    };
  }

  const totalTrials = normalized.length;
  const passedTrials = normalized.filter((t) => t.passed).length;

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
    trials: normalized,
  };
}
