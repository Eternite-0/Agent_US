import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { hasUnresolvedConflictMarkers } from './artifacts.js';

export const REVIEWER_SCHEMA_VERSION = '1.0.0';
export const MAX_REVIEWER_FORMAT_RETRIES = 2;

const MUTATING_TOOLS = new Set([
  'write_file',
  'edit_file',
  'apply_patch',
  'delete_file',
  'bash',
  'start_process',
]);

const CODE_MUTATING_TOOLS = new Set([
  'write_file',
  'edit_file',
  'apply_patch',
  'delete_file',
]);

const TEST_EXECUTION_TOOLS = new Set([
  'bash',
  'start_process',
  'run_command',
  'run_tests',
  'test',
]);

const VERDICT_MAP = new Map([
  ['pass', 'pass'],
  ['passed', 'pass'],
  ['approve', 'pass'],
  ['approved', 'pass'],
  ['accepted', 'pass'],
  ['fail', 'fail'],
  ['failed', 'fail'],
  ['reject', 'fail'],
  ['rejected', 'fail'],
  ['block', 'fail'],
  ['blocked', 'fail'],
  ['needs_revision', 'needs_revision'],
  ['needs_fix', 'needs_revision'],
  ['revise', 'needs_revision'],
]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Computes a deterministic SHA-256 digest over the durable upstream evidence
 * supplied to a Reviewer node so repair passes or outputs cannot silently swap
 * or fabricate underlying artifacts, receipts, or turn verdicts.
 */
export function computeReviewerEvidenceDigest(reviewerEvidence = null) {
  const src = isPlainObject(reviewerEvidence) ? reviewerEvidence : {};
  const artifacts = (Array.isArray(src.artifacts) ? src.artifacts : [])
    .map((a) => ({
      artifactId: String(a.artifactId ?? a.id ?? ''),
      uri: String(a.uri ?? ''),
      nodeKey: String(a.nodeKey ?? ''),
      bundleSha256: String(a.bundleSha256 ?? ''),
      status: String(a.status ?? ''),
      verified: Boolean(a.verified),
    }))
    .sort((a, b) => a.uri.localeCompare(b.uri) || a.artifactId.localeCompare(b.artifactId));

  const receipts = (Array.isArray(src.receipts) ? src.receipts : [])
    .map((r) => ({
      receiptId: String(r.receiptId ?? r.id ?? ''),
      turnId: String(r.turnId ?? ''),
      toolName: String(r.toolName ?? ''),
      status: String(r.status ?? ''),
      outputDigest: r.outputDigest ?? null,
      exitCode: r.exitCode ?? null,
    }))
    .sort((a, b) => a.receiptId.localeCompare(b.receiptId));

  const turnVerdicts = (Array.isArray(src.turnVerdicts) ? src.turnVerdicts : [])
    .map((t) => ({
      turnId: String(t.turnId ?? t.id ?? ''),
      state: String(t.state ?? ''),
      verdict: t.verdict ?? null,
      evidenceCount: Number(t.evidenceCount ?? 0),
    }))
    .sort((a, b) => a.turnId.localeCompare(b.turnId));

  const canonical = JSON.stringify({ artifacts, receipts, turnVerdicts });
  return createHash('sha256').update(canonical).digest('hex');
}

export function buildReviewerPromptConstraints(reviewerEvidence = null) {
  const digest = computeReviewerEvidenceDigest(reviewerEvidence);
  const artifactUris = (Array.isArray(reviewerEvidence?.artifacts) ? reviewerEvidence.artifacts : [])
    .map((a) => a.uri)
    .filter(Boolean);
  const receiptIds = (Array.isArray(reviewerEvidence?.receipts) ? reviewerEvidence.receipts : [])
    .map((r) => r.receiptId ?? r.id)
    .filter(Boolean);

  return [
    '[Strict Reviewer Output Schema]',
    `schemaVersion: "${REVIEWER_SCHEMA_VERSION}"`,
    `evidenceDigest: "${digest}"`,
    ...(artifactUris.length ? [`requiredArtifactInspection: ${JSON.stringify(artifactUris)}`] : []),
    ...(receiptIds.length ? [`availableReceiptIds: ${JSON.stringify(receiptIds)}`] : []),
    'You MUST output ONLY a single valid JSON object (raw JSON or a ```json fenced block) matching:',
    '```json',
    '{',
    `  "schemaVersion": "${REVIEWER_SCHEMA_VERSION}",`,
    '  "verdict": "pass | fail | needs_revision",',
    '  "summary": "concise factual review grounded in read_swarm_artifact and receipts",',
    `  "evidenceDigest": "${digest}",`,
    `  "checkedArtifacts": ${JSON.stringify(artifactUris)},`,
    `  "evidenceRefs": ${JSON.stringify(receiptIds.slice(0, 8))},`,
    '  "findings": [{ "severity": "info|low|medium|high|critical", "message": "...", "evidenceRef": "..." }]',
    '}',
    '```',
    'Rules:',
    '1. Read-only enforcement: NEVER modify workspace files; use only read-only inspection tools.',
    '2. Mandatory inspection: if artifacts exist, call read_swarm_artifact before emitting your verdict.',
    '3. Anti-tampering: preserve exact artifact URIs, receipt IDs, and evidenceDigest; never fabricate references.',
  ].join('\n');
}

function extractCandidateJsonStrings(rawText) {
  const text = String(rawText ?? '').trim();
  if (!text) return [];
  const candidates = [];

  if (text.startsWith('{') && text.endsWith('}')) {
    candidates.push(text);
  }

  const fenceRegex = /```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```/gi;
  let match;
  while ((match = fenceRegex.exec(text)) !== null) {
    const inner = String(match[1] ?? '').trim();
    if (inner.startsWith('{') && inner.endsWith('}')) {
      candidates.push(inner);
    }
  }
  return candidates;
}

/**
 * Parses and validates strict Reviewer JSON output. Rejects prose-only,
 * truncated, or non-JSON text while supporting canonical `verdict` as well as
 * compatible `decision` fields.
 */
export function parseReviewerOutput(rawText) {
  const errors = [];
  const candidates = extractCandidateJsonStrings(rawText);
  if (!candidates.length) {
    return {
      valid: false,
      status: null,
      parsed: null,
      normalized: null,
      rawJsonText: null,
      errors: ['Reviewer output must be a valid JSON object or ```json fenced block'],
    };
  }

  let parsed = null;
  let rawJsonText = null;
  for (let idx = candidates.length - 1; idx >= 0; idx--) {
    try {
      const candidate = JSON.parse(candidates[idx]);
      if (isPlainObject(candidate)) {
        parsed = candidate;
        rawJsonText = candidates[idx];
        break;
      }
    } catch (err) {
      if (idx === candidates.length - 1) {
        errors.push(`Invalid reviewer JSON: ${err.message}`);
      }
    }
  }

  if (!parsed) {
    if (!errors.length) errors.push('Reviewer JSON payload must be a plain object');
    return {
      valid: false,
      status: null,
      parsed: null,
      normalized: null,
      rawJsonText: null,
      errors,
    };
  }

  if (parsed.schemaVersion !== undefined) {
    if (typeof parsed.schemaVersion !== 'string' || !parsed.schemaVersion.startsWith('1.')) {
      errors.push(`Unsupported reviewer schemaVersion: ${String(parsed.schemaVersion)}`);
    }
  }

  const rawToken = parsed.verdict ?? parsed.decision ?? parsed.status;
  if (typeof rawToken !== 'string' || !rawToken.trim()) {
    errors.push('Missing reviewer verdict/decision field');
  }
  const normalizedStatus = typeof rawToken === 'string'
    ? VERDICT_MAP.get(rawToken.trim().toLowerCase()) ?? null
    : null;
  if (typeof rawToken === 'string' && rawToken.trim() && !normalizedStatus) {
    errors.push(`Invalid reviewer verdict/decision value: ${rawToken}`);
  }

  const checkedArtifactsRaw = parsed.checkedArtifacts ?? parsed.artifactUris;
  if (checkedArtifactsRaw !== undefined && (!Array.isArray(checkedArtifactsRaw) || !checkedArtifactsRaw.every((v) => typeof v === 'string'))) {
    errors.push('checkedArtifacts/artifactUris must be an array of strings');
  }

  const evidenceRefsRaw = parsed.evidenceRefs ?? parsed.receiptIds;
  if (evidenceRefsRaw !== undefined && (!Array.isArray(evidenceRefsRaw) || !evidenceRefsRaw.every((v) => typeof v === 'string'))) {
    errors.push('evidenceRefs/receiptIds must be an array of strings');
  }

  if (parsed.findings !== undefined) {
    if (!Array.isArray(parsed.findings) || !parsed.findings.every((f) => isPlainObject(f) && typeof f.message === 'string')) {
      errors.push('findings must be an array of objects with string message');
    }
  }

  if (parsed.summary !== undefined && typeof parsed.summary !== 'string') {
    errors.push('summary must be a string when present');
  }

  if (parsed.evidenceDigest !== undefined && typeof parsed.evidenceDigest !== 'string') {
    errors.push('evidenceDigest must be a string when present');
  }

  const valid = errors.length === 0 && Boolean(normalizedStatus);
  const normalized = valid
    ? {
        schemaVersion: String(parsed.schemaVersion || REVIEWER_SCHEMA_VERSION),
        verdict: normalizedStatus,
        decision: typeof parsed.decision === 'string'
          ? parsed.decision
          : normalizedStatus === 'pass'
            ? 'approved'
            : normalizedStatus === 'fail'
              ? 'rejected'
              : 'needs_revision',
        summary: String(parsed.summary ?? '').trim(),
        evidenceDigest: typeof parsed.evidenceDigest === 'string' ? parsed.evidenceDigest.trim() : null,
        checkedArtifacts: Array.isArray(checkedArtifactsRaw) ? [...new Set(checkedArtifactsRaw.map((v) => v.trim()).filter(Boolean))] : [],
        evidenceRefs: Array.isArray(evidenceRefsRaw) ? [...new Set(evidenceRefsRaw.map((v) => v.trim()).filter(Boolean))] : [],
        findings: Array.isArray(parsed.findings) ? parsed.findings : [],
      }
    : null;

  return {
    valid,
    status: normalizedStatus,
    parsed,
    normalized,
    rawJsonText,
    errors,
  };
}

function hasExplicitNegativeVerdictSignal(text) {
  const s = String(text ?? '');
  if (!s.trim()) return false;
  if (/"(?:verdict|decision|status)"\s*:\s*"(?:fail|failed|reject|rejected|block|blocked|needs_revision|needs_fix)"/i.test(s)) {
    return true;
  }
  if (/\b(?:verdict|decision)\s*[:=]\s*(?:fail|failed|rejected|reject|needs_revision)\b/i.test(s)) {
    return true;
  }
  return false;
}

function claimsCodeMutation(text) {
  const s = String(text ?? '');
  if (!s.trim()) return false;
  return /\b(?:implement(?:ed)?|fix(?:ed)?|patch(?:ed)?|edit(?:ed)?|modif(?:y|ied)|updat(?:e|ed)|refactor(?:ed)?|wrote|written|added|created|deleted|changed|diff|commit)\b|修复|修改|实现|重构|补丁/i.test(
    s,
  );
}

function claimsTestPass(text) {
  const s = String(text ?? '');
  if (!s.trim()) return false;
  return /\b(?:tests?\s+(?:passed|pass|passing|succeeded|green)|exit\s*code\s*[:=]?\s*0|all\s+\d+\s+tests?\s+pass)\b|测试通过/i.test(
    s,
  );
}

/**
 * Computes real workspace `git diff` file count and SHA-256 digest via hardened git
 * (including staged, unstaged, and untracked files outside `.agent-us-handoff`).
 */
export function inspectWorkspaceGitDiff(workspaceRoot) {
  if (!workspaceRoot || !existsSync(workspaceRoot)) {
    return { isGitRepo: false, diffFileCount: 0, diffDigest: null, files: [] };
  }
  const cwd = resolve(workspaceRoot);
  try {
    const inside = execFileSync('git', ['-C', cwd, 'rev-parse', '--is-inside-work-tree'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    if (inside !== 'true') {
      return { isGitRepo: false, diffFileCount: 0, diffDigest: null, files: [] };
    }
  } catch {
    return { isGitRepo: false, diffFileCount: 0, diffDigest: null, files: [] };
  }

  const changedFiles = [];
  const untrackedFiles = [];
  const seen = new Set();
  try {
    const statusBuf = execFileSync('git', ['-C', cwd, 'status', '--porcelain=v1', '-z'], {
      encoding: 'buffer',
      windowsHide: true,
      timeout: 10000,
      maxBuffer: 16 * 1024 * 1024,
    });
    const tokens = statusBuf.toString('utf8').split('\0');
    for (let i = 0; i < tokens.length; i += 1) {
      const rec = tokens[i];
      if (!rec || rec.length < 4) continue;
      const xy = rec.slice(0, 2);
      const pathA = rec.slice(3);
      if (xy[0] === 'R' || xy[0] === 'C') {
        i += 1;
      }
      const norm = pathA.replace(/\\/g, '/').replace(/^\/+/, '');
      if (
        !norm ||
        norm === '.agent-us-handoff' ||
        norm.startsWith('.agent-us-handoff/')
      ) {
        continue;
      }
      if (!seen.has(norm)) {
        seen.add(norm);
        changedFiles.push(norm);
        if (xy === '??') untrackedFiles.push(norm);
      }
    }
  } catch {
    return { isGitRepo: true, diffFileCount: 0, diffDigest: null, files: [] };
  }

  if (changedFiles.length === 0) {
    return { isGitRepo: true, diffFileCount: 0, diffDigest: null, files: [] };
  }

  let diffBuf = Buffer.alloc(0);
  try {
    diffBuf = execFileSync('git', ['-C', cwd, 'diff', '--binary', 'HEAD', '--', '.', ':(exclude).agent-us-handoff'], {
      encoding: 'buffer',
      windowsHide: true,
      timeout: 10000,
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch {
    try {
      const unstaged = execFileSync('git', ['-C', cwd, 'diff', '--binary'], {
        encoding: 'buffer',
        windowsHide: true,
        timeout: 10000,
        maxBuffer: 16 * 1024 * 1024,
      });
      const staged = execFileSync('git', ['-C', cwd, 'diff', '--cached', '--binary'], {
        encoding: 'buffer',
        windowsHide: true,
        timeout: 10000,
        maxBuffer: 16 * 1024 * 1024,
      });
      diffBuf = Buffer.concat([staged, unstaged]);
    } catch {
      diffBuf = Buffer.alloc(0);
    }
  }

  const hash = createHash('sha256');
  hash.update(changedFiles.slice().sort().join('\n'));
  hash.update('\n---\n');
  hash.update(diffBuf);
  for (const uf of untrackedFiles.slice().sort()) {
    try {
      const full = join(cwd, uf);
      if (existsSync(full)) {
        const bytes = readFileSync(full);
        hash.update(`\n??:${uf}:${bytes.length}:`);
        hash.update(bytes.subarray(0, 65536));
      }
    } catch {
      hash.update(`\n??:${uf}`);
    }
  }

  return {
    isGitRepo: true,
    diffFileCount: changedFiles.length,
    diffDigest: hash.digest('hex'),
    files: changedFiles,
  };
}

export function inspectArtifactDiffEvidence(reviewerEvidence = null, artifactManager = null) {
  const rawArtifacts = Array.isArray(reviewerEvidence?.artifacts) ? reviewerEvidence.artifacts : [];
  if (rawArtifacts.length === 0) {
    return { artifactDiffCount: 0, artifactDiffDigest: null, files: [], hasOpaqueStubArtifact: false };
  }

  const files = [];
  const seen = new Set();
  const patchChunks = [];
  let explicitFileCount = 0;
  let hasOpaqueStubArtifact = false;

  for (const item of rawArtifacts) {
    if (!item || item.verified === false) continue;
    const loaded =
      artifactManager?.getArtifact && (item.artifactId || item.id || item.uri)
        ? artifactManager.getArtifact(item.artifactId || item.id || item.uri)
        : null;
    const art = loaded ?? item;
    const entryList = Array.isArray(art.files) ? art.files : null;
    if (entryList) {
      const effectiveEntries = entryList.filter((e) => !e.overlaidDeleted && !e.overlaidReverted);
      explicitFileCount = Math.max(explicitFileCount, effectiveEntries.length);
      for (const e of effectiveEntries) {
        if (e?.path && !seen.has(e.path)) {
          seen.add(e.path);
          files.push(e.path);
        }
      }
      if (art.storagePath) {
        const patchFile = join(art.storagePath, art.manifest?.patchFile || 'changes.patch');
        if (existsSync(patchFile)) {
          try {
            const p = readFileSync(patchFile);
            if (p.length > 0) patchChunks.push(p);
          } catch {
            // fallback to entry hashes below
          }
        }
      }
      if (patchChunks.length === 0 && effectiveEntries.length > 0) {
        patchChunks.push(
          Buffer.from(
            effectiveEntries
              .map((e) => `${e.changeType || 'modified'}:${e.path}:${e.sha256 || ''}:${e.mode || '100644'}`)
              .join('\n'),
            'utf8',
          ),
        );
      }
    } else if (Number.isFinite(Number(art.fileCount))) {
      explicitFileCount += Number(art.fileCount);
    } else if (art.bundleSha256) {
      hasOpaqueStubArtifact = true;
    }
  }

  const count = Math.max(files.length, explicitFileCount);
  if (count === 0) {
    return { artifactDiffCount: 0, artifactDiffDigest: null, files: [], hasOpaqueStubArtifact };
  }

  const hash = createHash('sha256');
  hash.update(files.slice().sort().join('\n'));
  for (const c of patchChunks) {
    hash.update('\n');
    hash.update(c);
  }
  return {
    artifactDiffCount: count,
    artifactDiffDigest: hash.digest('hex'),
    files,
    hasOpaqueStubArtifact: false,
  };
}

export function inspectTestExecutionReceipts(reviewerEvidence = null) {
  const verificationResults = Array.isArray(reviewerEvidence?.verificationResults)
    ? reviewerEvidence.verificationResults
    : [];
  const receipts = Array.isArray(reviewerEvidence?.receipts) ? reviewerEvidence.receipts : [];

  for (const vr of verificationResults) {
    if (!vr || typeof vr !== 'object') continue;
    const exitCode = vr.exitCode !== undefined && vr.exitCode !== null ? Number(vr.exitCode) : null;
    if (vr.status === 'failed' || (exitCode !== null && exitCode !== 0)) {
      return { hasTestReceipt: true, passed: false, verifiedTestExitCode: exitCode ?? 1 };
    }
  }

  const shellReceipts = receipts.filter((r) => TEST_EXECUTION_TOOLS.has(String(r?.toolName ?? '')));
  if (shellReceipts.length > 0) {
    const latestByTurn = new Map();
    for (const r of shellReceipts) {
      const key = String(r.turnId ?? r.sessionId ?? '_default');
      latestByTurn.set(key, r);
    }
    let anyPassedZero = false;
    for (const r of latestByTurn.values()) {
      const code = r.exitCode !== undefined && r.exitCode !== null ? Number(r.exitCode) : null;
      if (r.status === 'failed' || (code !== null && code !== 0)) {
        return { hasTestReceipt: true, passed: false, verifiedTestExitCode: code ?? 1 };
      }
      if (r.status === 'finished' && code === 0) {
        anyPassedZero = true;
      }
    }
    if (anyPassedZero) {
      return { hasTestReceipt: true, passed: true, verifiedTestExitCode: 0 };
    }
  }

  for (const vr of verificationResults) {
    if (!vr || typeof vr !== 'object') continue;
    const exitCode = vr.exitCode !== undefined && vr.exitCode !== null ? Number(vr.exitCode) : null;
    if (vr.status === 'passed' && exitCode === 0) {
      return { hasTestReceipt: true, passed: true, verifiedTestExitCode: 0 };
    }
  }

  if (
    reviewerEvidence &&
    reviewerEvidence.testExitCode !== undefined &&
    reviewerEvidence.testExitCode !== null
  ) {
    const code = Number(reviewerEvidence.testExitCode);
    return { hasTestReceipt: true, passed: code === 0, verifiedTestExitCode: code };
  }

  return { hasTestReceipt: false, passed: false, verifiedTestExitCode: null };
}

/**
 * Evaluates hard verification gates on real `git diff` (workspace or verified artifacts)
 * and test execution receipt (`exitCode === 0`). Refuses/downgrades any synthetic/LLM `'pass'`
 * verdict when claimed mutations have 0 real `git diff` or missing/non-zero test `exitCode`.
 */
export function evaluateReviewerHardGate({
  parsedVerdict = null,
  reviewerEvidence = null,
  workspaceRoot = null,
  artifactManager = null,
  gitDiff = null,
  claimedMutations = undefined,
  requireGitDiff = undefined,
  requireTestExecution = undefined,
  hardGate = undefined,
} = {}) {
  const wsDiff =
    gitDiff && typeof gitDiff === 'object'
      ? {
          isGitRepo: true,
          diffFileCount: Math.max(0, Number(gitDiff.diffFileCount ?? 0)),
          diffDigest: gitDiff.diffDigest ?? null,
          files: Array.isArray(gitDiff.files) ? gitDiff.files : [],
        }
      : workspaceRoot
        ? inspectWorkspaceGitDiff(workspaceRoot)
        : null;

  const artDiff = inspectArtifactDiffEvidence(reviewerEvidence, artifactManager);
  const mergedFiles = [...new Set([...(wsDiff?.files ?? []), ...(artDiff?.files ?? [])])];
  const diffFileCount = Math.max(
    Number(wsDiff?.diffFileCount ?? 0),
    Number(artDiff?.artifactDiffCount ?? 0),
    mergedFiles.length,
  );
  const diffDigest =
    diffFileCount > 0
      ? wsDiff?.diffDigest && artDiff?.artifactDiffDigest
        ? createHash('sha256')
            .update(`${wsDiff.diffDigest}:${artDiff.artifactDiffDigest}`)
            .digest('hex')
        : wsDiff?.diffDigest ||
          artDiff?.artifactDiffDigest ||
          createHash('sha256').update(mergedFiles.slice().sort().join('\n')).digest('hex')
      : null;
  const verifiedGitDiff = diffFileCount > 0 && Boolean(diffDigest);

  const testInfo = inspectTestExecutionReceipts(reviewerEvidence);
  const verifiedTestExitCode = testInfo.verifiedTestExitCode;

  const hasUpstreamCodeReceipt = (reviewerEvidence?.receipts ?? []).some((r) =>
    CODE_MUTATING_TOOLS.has(String(r?.toolName ?? '')),
  );
  const hasMutatingSourceNode = (reviewerEvidence?.sourceNodes ?? []).some(
    (n) => n?.taskType === 'implementation' || n?.isolationMode === 'worktree',
  );
  const hasArtifactClaim =
    (reviewerEvidence?.artifacts?.length ?? 0) > 0 ||
    (parsedVerdict?.checkedArtifacts?.length ?? 0) > 0;
  const summaryClaimsMutation = claimsCodeMutation(parsedVerdict?.summary);
  const isPureOpaqueUnitStub =
    hardGate !== true &&
    !workspaceRoot &&
    !gitDiff &&
    artDiff.hasOpaqueStubArtifact &&
    diffFileCount === 0;

  const effRequireGitDiff =
    requireGitDiff !== undefined
      ? Boolean(requireGitDiff)
      : claimedMutations !== undefined
        ? Boolean(claimedMutations)
        : !isPureOpaqueUnitStub &&
          Boolean(
            hardGate === true ||
              workspaceRoot ||
              gitDiff ||
              hasUpstreamCodeReceipt ||
              hasMutatingSourceNode ||
              hasArtifactClaim ||
              summaryClaimsMutation,
          );

  const effRequireTestExecution =
    requireTestExecution !== undefined
      ? Boolean(requireTestExecution)
      : Boolean(
          hardGate === true ||
            workspaceRoot != null ||
            gitDiff != null ||
            testInfo.hasTestReceipt ||
            claimsTestPass(parsedVerdict?.summary),
        );

  const reasons = [];
  if (effRequireGitDiff && !verifiedGitDiff) {
    reasons.push('MISSING_REAL_GIT_DIFF');
  }
  if (testInfo.hasTestReceipt && !testInfo.passed) {
    reasons.push(`TEST_EXIT_CODE_FAILED:${verifiedTestExitCode}`);
  } else if (effRequireTestExecution && (!testInfo.hasTestReceipt || verifiedTestExitCode !== 0)) {
    reasons.push('MISSING_VERIFIED_TEST_EXIT_CODE');
  }

  const rawVerdict = parsedVerdict?.verdict ?? null;
  const hardGatePassed = reasons.length === 0;
  const downgraded = rawVerdict === 'pass' && !hardGatePassed;
  const finalVerdict = downgraded ? 'fail' : (rawVerdict ?? (hardGatePassed ? 'pass' : 'fail'));

  return {
    verifiedGitDiff,
    diffFileCount,
    diffDigest,
    verifiedTestExitCode,
    hardGatePassed,
    verdict: finalVerdict,
    reasons,
    downgraded,
    originalVerdict: rawVerdict,
  };
}

/**
 * Verifies a bounded `conflict_resolution` repair step before acceptance:
 * 1. Zero remaining `<<<<<<<` / `=======` / `>>>>>>>` conflict markers in resolved/artifact files
 * 2. Every conflicted file is addressed in the resolution artifact / diff
 * 3. `evaluateReviewerHardGate` passes with real git diff (>0 files + digest) and test exitCode === 0.
 */
export function evaluateConflictResolutionGate({
  conflictFiles = [],
  artifact = null,
  artifactManager = null,
  reviewerEvidence = null,
  workspaceRoot = null,
  gitDiff = null,
  precomputedRemainingMarkers = null,
} = {}) {
  const normalizedConflictFiles = [
    ...new Set((Array.isArray(conflictFiles) ? conflictFiles : []).map((f) => String(f || '').trim()).filter(Boolean)),
  ];
  const remainingMarkerSet = new Set(
    Array.isArray(precomputedRemainingMarkers) ? precomputedRemainingMarkers : [],
  );
  const artifactFiles = new Set((artifact?.files ?? []).map((f) => f.path).filter(Boolean));
  const diffFiles = new Set((gitDiff?.files ?? []).map(String).filter(Boolean));
  const checkPaths = [...new Set([...normalizedConflictFiles, ...artifactFiles])];

  for (const rel of checkPaths) {
    let content = null;
    if (artifact && artifactManager?.readArtifactFile && artifactFiles.has(rel)) {
      const entry = (artifact.files ?? []).find((f) => f.path === rel);
      if (entry && entry.changeType !== 'deleted' && !entry.binary && entry.mode !== '120000') {
        try {
          content = artifactManager.readArtifactFile(artifact.id, rel).buffer;
        } catch {
          content = null;
        }
      }
    }
    if (content === null && workspaceRoot) {
      const full = join(resolve(workspaceRoot), rel);
      if (existsSync(full)) {
        try {
          content = readFileSync(full);
        } catch {
          content = null;
        }
      }
    }
    if (content !== null && hasUnresolvedConflictMarkers(content)) {
      remainingMarkerSet.add(rel);
    }
  }

  const untouchedConflictFiles = normalizedConflictFiles.filter(
    (f) => !artifactFiles.has(f) && !diffFiles.has(f),
  );

  const gate = evaluateReviewerHardGate({
    parsedVerdict: {
      verdict: 'pass',
      summary: 'Conflict resolution verified with resolved hunks and passing tests.',
      ...(artifact?.uri ? { checkedArtifacts: [artifact.uri] } : {}),
    },
    reviewerEvidence,
    workspaceRoot,
    artifactManager,
    gitDiff,
    requireGitDiff: true,
    requireTestExecution: true,
    hardGate: true,
  });

  const remainingMarkers = [...remainingMarkerSet];
  const reasons = [...(gate.reasons ?? [])];
  if (remainingMarkers.length > 0) {
    reasons.push(`REMAINING_CONFLICT_MARKERS:${remainingMarkers.join(',')}`);
  }
  if (untouchedConflictFiles.length > 0) {
    reasons.push(`CONFLICT_FILES_UNTOUCHED:${untouchedConflictFiles.join(',')}`);
  }

  const hardGatePassed =
    Boolean(gate.hardGatePassed) &&
    remainingMarkers.length === 0 &&
    untouchedConflictFiles.length === 0;

  return {
    resolved: hardGatePassed,
    hardGatePassed,
    testExitCode: gate.verifiedTestExitCode ?? null,
    verifiedGitDiff: Boolean(gate.verifiedGitDiff),
    diffFileCount: Number(gate.diffFileCount ?? 0),
    diffDigest: gate.diffDigest ?? null,
    remainingMarkers,
    untouchedConflictFiles,
    reasons,
  };
}

/**
 * Validates a Reviewer turn output together with actual SQLite tool_receipts,
 * upstream evidence manifest, real git diff, and test execution receipts to enforce
 * schema compliance, read-only behavior, mandatory artifact reads, zero evidence tampering,
 * and hard verification gates.
 */
export function validateReviewerExecution({
  rawText,
  reviewerEvidence = null,
  toolReceipts = [],
  originalRawText = null,
  workspaceRoot = null,
  artifactManager = null,
  gitDiff = null,
  claimedMutations = undefined,
  requireGitDiff = undefined,
  requireTestExecution = undefined,
  hardGate = undefined,
} = {}) {
  const receipts = Array.isArray(toolReceipts) ? toolReceipts : [];
  const writeViolations = receipts.filter(
    (r) => MUTATING_TOOLS.has(String(r.toolName ?? '')) && r.status === 'finished',
  );
  const readArtifactReceipts = receipts.filter(
    (r) => String(r.toolName ?? '') === 'read_swarm_artifact' && r.status === 'finished',
  );
  const expectedDigest = computeReviewerEvidenceDigest(reviewerEvidence);

  if (writeViolations.length > 0) {
    return {
      valid: false,
      code: 'REVIEWER_WRITE_POLICY_VIOLATION',
      status: null,
      verdict: null,
      rawJsonText: null,
      errors: [`Reviewer must remain read-only; observed ${writeViolations.length} completed mutating tool call(s)`],
      readArtifactCount: readArtifactReceipts.length,
      writeViolationCount: writeViolations.length,
      evidenceDigest: expectedDigest,
    };
  }

  const parsed = parseReviewerOutput(rawText);
  if (!parsed.valid) {
    return {
      valid: false,
      code: 'REVIEWER_OUTPUT_MALFORMED',
      status: null,
      verdict: null,
      rawJsonText: null,
      errors: parsed.errors,
      readArtifactCount: readArtifactReceipts.length,
      writeViolationCount: 0,
      evidenceDigest: expectedDigest,
    };
  }

  const expectedArtifacts = Array.isArray(reviewerEvidence?.artifacts) ? reviewerEvidence.artifacts : [];
  if (expectedArtifacts.length > 0 && readArtifactReceipts.length === 0) {
    return {
      valid: false,
      code: 'REVIEWER_ARTIFACT_READ_REQUIRED',
      status: parsed.status,
      verdict: parsed.normalized,
      rawJsonText: parsed.rawJsonText,
      errors: ['Reviewer must call read_swarm_artifact to inspect upstream artifacts before issuing a verdict'],
      readArtifactCount: 0,
      writeViolationCount: 0,
      evidenceDigest: expectedDigest,
    };
  }

  const knownArtifactUris = new Set(expectedArtifacts.map((a) => String(a.uri ?? '')).filter(Boolean));
  if (expectedArtifacts.length > 0) {
    for (const uri of parsed.normalized.checkedArtifacts) {
      if (!knownArtifactUris.has(uri)) {
        return {
          valid: false,
          code: 'REVIEWER_EVIDENCE_TAMPERED',
          status: parsed.status,
          verdict: parsed.normalized,
          rawJsonText: parsed.rawJsonText,
          errors: [`Reviewer referenced unknown or fabricated artifact URI: ${uri}`],
          readArtifactCount: readArtifactReceipts.length,
          writeViolationCount: 0,
          evidenceDigest: expectedDigest,
        };
      }
    }
  }

  if (parsed.normalized.evidenceDigest && parsed.normalized.evidenceDigest !== expectedDigest) {
    return {
      valid: false,
      code: 'REVIEWER_EVIDENCE_TAMPERED',
      status: parsed.status,
      verdict: parsed.normalized,
      rawJsonText: parsed.rawJsonText,
      errors: [`Reviewer evidenceDigest mismatch (expected ${expectedDigest}, got ${parsed.normalized.evidenceDigest})`],
      readArtifactCount: readArtifactReceipts.length,
      writeViolationCount: 0,
      evidenceDigest: expectedDigest,
    };
  }

  if (originalRawText && String(originalRawText) !== String(rawText)) {
    if (hasExplicitNegativeVerdictSignal(originalRawText) && parsed.status === 'pass') {
      return {
        valid: false,
        code: 'REVIEWER_EVIDENCE_TAMPERED',
        status: parsed.status,
        verdict: parsed.normalized,
        rawJsonText: parsed.rawJsonText,
        errors: ['Reviewer format-repair output flipped a negative verdict into pass'],
        readArtifactCount: readArtifactReceipts.length,
        writeViolationCount: 0,
        evidenceDigest: expectedDigest,
      };
    }
  }

  const reviewerVerification = evaluateReviewerHardGate({
    parsedVerdict: parsed.normalized,
    reviewerEvidence,
    workspaceRoot,
    artifactManager,
    gitDiff,
    claimedMutations,
    requireGitDiff,
    requireTestExecution,
    hardGate,
  });

  if (parsed.status === 'pass' && !reviewerVerification.hardGatePassed) {
    const downgradedVerdict = {
      ...parsed.normalized,
      verdict: reviewerVerification.verdict,
      decision: 'rejected',
      downgradedFrom: 'pass',
      reviewerVerification,
    };
    return {
      valid: false,
      code: 'REVIEWER_HARD_GATE_FAILED',
      status: reviewerVerification.verdict,
      verdict: downgradedVerdict,
      rawJsonText: JSON.stringify(downgradedVerdict),
      errors: reviewerVerification.reasons,
      readArtifactCount: readArtifactReceipts.length,
      writeViolationCount: 0,
      evidenceDigest: expectedDigest,
      reviewerVerification,
    };
  }

  return {
    valid: true,
    code: null,
    status: parsed.status,
    verdict: {
      ...parsed.normalized,
      reviewerVerification,
    },
    rawJsonText: parsed.rawJsonText,
    errors: [],
    readArtifactCount: readArtifactReceipts.length,
    writeViolationCount: 0,
    evidenceDigest: expectedDigest,
    reviewerVerification,
  };
}

export function buildReviewerFormatRepairPrompt({
  originalRawText = '',
  errors = [],
  reviewerEvidence = null,
} = {}) {
  const digest = computeReviewerEvidenceDigest(reviewerEvidence);
  const artifactUris = (Array.isArray(reviewerEvidence?.artifacts) ? reviewerEvidence.artifacts : [])
    .map((a) => a.uri)
    .filter(Boolean);
  return [
    '[Reviewer Format Repair Required]',
    'Your previous review output did not conform to the strict Reviewer JSON Schema 1.0.0.',
    `Validation errors: ${JSON.stringify(errors)}`,
    'Reformat ONLY your previous findings and verdict into a valid single JSON object.',
    'STRICT PROHIBITION: Do NOT change your verdict direction, do NOT remove findings, and do NOT fabricate artifact URIs or receipt IDs.',
    `Required evidenceDigest: "${digest}"`,
    ...(artifactUris.length ? [`Valid artifact URIs: ${JSON.stringify(artifactUris)}`] : []),
    '',
    'Original output to reformat:',
    String(originalRawText ?? '').slice(0, 4000),
  ].join('\n');
}
