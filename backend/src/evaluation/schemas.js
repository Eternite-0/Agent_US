import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

export const EVIDENCE_MANIFEST_SCHEMA_VERSION = '1.0.0';
export const EVIDENCE_STATUSES = Object.freeze({
  VALID: 'valid',
  INCOMPLETE: 'EVIDENCE_INCOMPLETE',
  INVALID: 'invalid',
});
export const TRUSTED_VERDICT_SOURCES = Object.freeze(
  new Set(['independent_reviewer', 'trusted_server_verifier', 'trusted_verifier']),
);

export class EvaluationSchemaError extends Error {
  constructor(message, detail = undefined) {
    super(message);
    this.name = 'EvaluationSchemaError';
    this.code = 'E_EVAL_SCHEMA';
    if (detail !== undefined) this.detail = detail;
  }
}

const TASK_ID = /^[a-z0-9][a-z0-9._-]{2,127}$/;
const STATUSES = new Set(['passed', 'failed', 'cancelled', 'timeout']);

function fail(message, detail) {
  throw new EvaluationSchemaError(message, detail);
}

function positiveInt(value, field, { allowZero = false } = {}) {
  if (!Number.isInteger(value) || (allowZero ? value < 0 : value <= 0)) {
    fail(`${field} must be ${allowZero ? 'a non-negative' : 'a positive'} integer`, { field, value });
  }
  return value;
}

export function validateTask(task) {
  if (!task || typeof task !== 'object') fail('task must be an object');
  if (typeof task.id !== 'string' || !TASK_ID.test(task.id)) {
    fail('task.id must be a stable lowercase identifier', { id: task.id });
  }
  if (typeof task.title !== 'string' || !task.title.trim()) fail('task.title is required');
  if (typeof task.prompt !== 'string' || !task.prompt.trim()) fail('task.prompt is required');
  if (!task.expected || typeof task.expected !== 'object') fail('task.expected must be an object');
  if (task.category !== undefined && (typeof task.category !== 'string' || !task.category.trim())) {
    fail('task.category must be a non-empty string');
  }
  if (task.difficulty !== undefined && !['easy', 'medium', 'hard'].includes(task.difficulty)) {
    fail('task.difficulty must be easy, medium, or hard');
  }
  if (task.timeoutMs !== undefined) positiveInt(task.timeoutMs, 'task.timeoutMs');
  if (task.maxAttempts !== undefined) positiveInt(task.maxAttempts, 'task.maxAttempts');
  if (task.fixture !== undefined && (typeof task.fixture !== 'object' || task.fixture === null)) {
    fail('task.fixture must be an object');
  }
  if (task.judge !== undefined && typeof task.judge !== 'function') {
    fail('task.judge must be a function when provided');
  }
  return task;
}

export function validateRunnerOptions(options = {}) {
  if (!options || typeof options !== 'object') fail('runner options must be an object');
  if (options.concurrency !== undefined) positiveInt(options.concurrency, 'concurrency');
  if (options.timeoutMs !== undefined) positiveInt(options.timeoutMs, 'timeoutMs');
  if (options.maxAttempts !== undefined) positiveInt(options.maxAttempts, 'maxAttempts');
  const budget = options.budget ?? {};
  if (budget.maxTasks !== undefined) positiveInt(budget.maxTasks, 'budget.maxTasks');
  if (budget.maxAttempts !== undefined) positiveInt(budget.maxAttempts, 'budget.maxAttempts');
  if (budget.maxConcurrent !== undefined) positiveInt(budget.maxConcurrent, 'budget.maxConcurrent');
  return options;
}

export function validateResult(result) {
  if (!result || typeof result !== 'object') fail('result must be an object');
  if (typeof result.taskId !== 'string' || !TASK_ID.test(result.taskId)) fail('result.taskId is invalid');
  if (!STATUSES.has(result.status)) fail('result.status is invalid', { status: result.status });
  if (!Number.isInteger(result.attempts) || result.attempts < 1) fail('result.attempts must be positive');
  if (typeof result.passed !== 'boolean') fail('result.passed must be boolean');
  return result;
}

export function validateReport(report) {
  if (!report || typeof report !== 'object') fail('report must be an object');
  if (!Array.isArray(report.results)) fail('report.results must be an array');
  report.results.forEach(validateResult);
  return report;
}

export function normalizeEvidencePath(value) {
  return String(value ?? '').replaceAll('\\', '/').replace(/^\.\//, '').trim();
}

export function normalizeCommandString(cmd) {
  const raw = Array.isArray(cmd) ? cmd.join(' ') : String(cmd ?? '');
  return raw.replace(/\s+/g, ' ').trim();
}

export function tryParseJsonObject(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function extractEvidenceManifest(rawOrOutput) {
  let value = rawOrOutput;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if (Object.hasOwn(value, 'output')) value = value.output;
    else if (Object.hasOwn(value, 'result')) value = value.result;
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const candidate = value.evidence && typeof value.evidence === 'object' ? value.evidence : value;
    return { found: true, manifest: candidate, source: 'object', rawText: '' };
  }
  const src = String(value ?? '');
  const direct = tryParseJsonObject(src);
  if (direct) {
    const candidate = direct.evidence && typeof direct.evidence === 'object' ? direct.evidence : direct;
    return { found: true, manifest: candidate, source: 'json', rawText: src };
  }
  const fencedMatches = [...src.matchAll(/```(?:json)?\s*\r?\n?([\s\S]*?)```/gi)];
  for (let i = fencedMatches.length - 1; i >= 0; i -= 1) {
    const parsed = tryParseJsonObject(fencedMatches[i][1]);
    if (parsed) {
      const candidate = parsed.evidence && typeof parsed.evidence === 'object' ? parsed.evidence : parsed;
      return { found: true, manifest: candidate, source: 'fenced', rawText: src };
    }
  }
  const parsedObjects = [];
  for (let i = 0; i < src.length; i += 1) {
    if (src[i] !== '{') continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let j = i; j < src.length; j += 1) {
      const ch = src[j];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          const parsed = tryParseJsonObject(src.slice(i, j + 1));
          if (parsed) {
            parsedObjects.push(parsed);
            i = j;
          }
          break;
        }
      }
    }
  }
  if (parsedObjects.length) {
    const last = parsedObjects[parsedObjects.length - 1];
    const candidate = last.evidence && typeof last.evidence === 'object' ? last.evidence : last;
    return { found: true, manifest: candidate, source: 'scanned', rawText: src };
  }
  return { found: false, manifest: null, source: 'none', rawText: src };
}

export function formatEvidenceManifestContract({
  taskId,
  attemptId = 'attempt-1',
  planVersion = 1,
  testCommand = [],
  requiredChangedFiles = [],
} = {}) {
  const commandStr = normalizeCommandString(testCommand);
  const template = {
    schemaVersion: EVIDENCE_MANIFEST_SCHEMA_VERSION,
    taskId: String(taskId || ''),
    attemptId: String(attemptId || 'attempt-1'),
    planVersion: Number(planVersion ?? 1),
    summary: 'Concise summary of actual changes and verified test results',
    changedFiles: Array.isArray(requiredChangedFiles) ? requiredChangedFiles : [],
    testCommand: commandStr,
    testExitCode: 0,
    testEvidence: [
      {
        command: commandStr,
        exitCode: 0,
      },
    ],
    artifactRefs: [],
  };
  return [
    '[Engineering Evidence Manifest v1.0.0 Contract]',
    'Before finishing, you MUST actually modify files, run the required test command via the bash tool, and end your final response with a valid JSON block matching this exact schema (do not invent fields; independentVerdict is assigned server-side by the verifier/reviewer, do not self-attest true):',
    '```json',
    JSON.stringify(template, null, 2),
    '```',
  ].join('\n');
}

function sha256File(fullPath) {
  return createHash('sha256').update(readFileSync(fullPath)).digest('hex');
}

function resolveInsideWorkspace(workspaceRoot, relPath) {
  const base = resolve(String(workspaceRoot));
  const target = resolve(base, String(relPath));
  const rel = relative(base, target);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
  return target;
}

function receiptMatchesExpectedCommand(receiptCommand, expectedCmd) {
  if (!expectedCmd) return true;
  if (!receiptCommand) return false;
  const normActual = normalizeCommandString(receiptCommand).replaceAll('\\', '/');
  const normExpected = normalizeCommandString(expectedCmd).replaceAll('\\', '/');
  if (normActual.includes(normExpected)) return true;
  const tokens = normExpected.split(/\s+/).filter(Boolean);
  const testFiles = tokens.filter((t) => /\.(?:test|spec)\.[cm]?[jt]s$/i.test(t) || t.includes('test/'));
  return tokens.includes('--test')
    ? /\bnode\b/.test(normActual) && /--test/.test(normActual) && testFiles.every((f) => normActual.includes(normalizeEvidencePath(f)))
    : normActual.includes(normExpected);
}

export function validateEvidenceManifest(rawOrOutput, context = {}) {
  const extracted = extractEvidenceManifest(rawOrOutput);
  const manifest = extracted.found ? extracted.manifest : null;
  const missingFields = [];
  const errors = [];

  if (!manifest || typeof manifest !== 'object') {
    return {
      valid: false,
      status: EVIDENCE_STATUSES.INCOMPLETE,
      missingFields: ['manifest'],
      errors: ['Missing JSON engineering evidence manifest'],
      checks: {
        manifestPresent: false,
        schemaVersion: false,
        bindings: false,
        changedFiles: false,
        reportedChangedFiles: false,
        tests: false,
        testCommand: false,
        testEvidence: false,
        testReceiptVerified: context.toolReceipts ? false : true,
        artifactsVerified: true,
        independentVerdict: false,
      },
      manifest: null,
      source: extracted.source,
    };
  }

  const expectedTaskId = context.taskId ? String(context.taskId) : null;
  const expectedAttemptId = context.attemptId ? String(context.attemptId) : null;
  const expectedPlanVersion = context.planVersion !== undefined && context.planVersion !== null
    ? Number(context.planVersion)
    : null;
  const expectedCmd = normalizeCommandString(context.expectedTestCommand ?? context.testCommand ?? '');
  const requiredChangedFiles = Array.isArray(context.requiredChangedFiles)
    ? context.requiredChangedFiles.map(normalizeEvidencePath).filter(Boolean)
    : [];
  const actualChangedFiles = Array.isArray(context.actualChangedFiles)
    ? context.actualChangedFiles.map(normalizeEvidencePath).filter(Boolean)
    : null;
  const requireIndependentVerdict = context.requireIndependentVerdict !== false;

  if (!manifest.schemaVersion) missingFields.push('schemaVersion');
  else if (String(manifest.schemaVersion) !== EVIDENCE_MANIFEST_SCHEMA_VERSION) {
    errors.push(`Unsupported schemaVersion: ${manifest.schemaVersion}`);
  }

  if (!manifest.taskId) missingFields.push('taskId');
  else if (expectedTaskId && String(manifest.taskId) !== expectedTaskId) {
    errors.push(`taskId mismatch: expected ${expectedTaskId}, got ${manifest.taskId}`);
  }

  if (!manifest.attemptId) missingFields.push('attemptId');
  else if (expectedAttemptId && String(manifest.attemptId) !== expectedAttemptId) {
    errors.push(`attemptId mismatch: expected ${expectedAttemptId}, got ${manifest.attemptId}`);
  }

  if (manifest.planVersion === undefined || manifest.planVersion === null || manifest.planVersion === '') {
    missingFields.push('planVersion');
  } else if (!Number.isInteger(Number(manifest.planVersion)) || Number(manifest.planVersion) < 1) {
    errors.push(`Invalid planVersion: ${manifest.planVersion}`);
  } else if (expectedPlanVersion !== null && Number(manifest.planVersion) !== expectedPlanVersion) {
    errors.push(`planVersion mismatch: expected ${expectedPlanVersion}, got ${manifest.planVersion}`);
  }

  if (typeof manifest.summary !== 'string' || !manifest.summary.trim()) {
    missingFields.push('summary');
  }

  const reportedFiles = Array.isArray(manifest.changedFiles)
    ? manifest.changedFiles.map(normalizeEvidencePath).filter(Boolean)
    : null;
  if (!reportedFiles || reportedFiles.length === 0) {
    missingFields.push('changedFiles');
  }

  const changedFilesOk = actualChangedFiles
    ? requiredChangedFiles.every((f) => actualChangedFiles.includes(f))
    : true;
  if (!changedFilesOk) {
    errors.push('Required workspace changes are not present in real Git diff');
  }

  let reportedChangedFilesOk = Boolean(reportedFiles && reportedFiles.length > 0);
  if (reportedChangedFilesOk && actualChangedFiles) {
    reportedChangedFilesOk =
      reportedFiles.every((f) => actualChangedFiles.includes(f)) &&
      requiredChangedFiles.every((f) => reportedFiles.includes(f));
    if (!reportedChangedFilesOk) {
      errors.push('Manifest changedFiles does not match actual Git diff');
    }
  } else if (reportedChangedFilesOk && requiredChangedFiles.length > 0) {
    reportedChangedFilesOk = requiredChangedFiles.every((f) => reportedFiles.includes(f));
    if (!reportedChangedFilesOk) {
      errors.push('Manifest changedFiles omits required files');
    }
  }

  const reportedCmd = normalizeCommandString(manifest.testCommand);
  if (!reportedCmd) missingFields.push('testCommand');
  const testCommandOk = Boolean(reportedCmd) && (!expectedCmd || reportedCmd === expectedCmd);
  if (reportedCmd && expectedCmd && !testCommandOk) {
    errors.push(`testCommand mismatch: expected "${expectedCmd}", got "${reportedCmd}"`);
  }

  const hasValidExitInt = Number.isInteger(manifest.testExitCode);
  if (!hasValidExitInt) missingFields.push('testExitCode');
  else if (manifest.testExitCode !== 0) {
    errors.push(`Reported testExitCode is non-zero (${manifest.testExitCode})`);
  }

  const testEvidence = Array.isArray(manifest.testEvidence) ? manifest.testEvidence : null;
  if (!testEvidence || testEvidence.length === 0) {
    missingFields.push('testEvidence');
  }
  const testEvidenceValid = Boolean(
    testEvidence &&
      testEvidence.some((entry) => {
        if (!entry || typeof entry !== 'object') return false;
        const entryCmd = normalizeCommandString(entry.command);
        const cmdMatch = !expectedCmd || entryCmd === expectedCmd;
        return cmdMatch && Number.isInteger(entry.exitCode) && entry.exitCode === 0;
      }),
  );
  if (testEvidence && testEvidence.length > 0 && !testEvidenceValid) {
    errors.push('testEvidence does not contain a passing entry for the expected test command');
  }

  let testReceiptVerified = true;
  if (Array.isArray(context.toolReceipts)) {
    const allShellReceipts = context.toolReceipts.filter(
      (r) => r && ['bash', 'start_process'].includes(String(r.toolName)),
    );
    const matching = allShellReceipts.filter((r) => receiptMatchesExpectedCommand(r.command, expectedCmd));
    const latestMatch = matching.at(-1) ?? null;
    testReceiptVerified = Boolean(
      latestMatch &&
        latestMatch.status === 'finished' &&
        (latestMatch.exitCode === undefined || latestMatch.exitCode === null || Number(latestMatch.exitCode) === 0),
    );
    if (!testReceiptVerified) {
      missingFields.push('testExecutionReceipt');
      errors.push('No verified passing latest shell tool_receipt found matching expected testCommand');
    }
  }

  const actualTestOk = context.actualTestExitCode === undefined ? true : context.actualTestExitCode === 0;
  const testsOk = actualTestOk && hasValidExitInt && manifest.testExitCode === 0 && testEvidenceValid && testReceiptVerified;

  let artifactsVerified = true;
  if (manifest.artifactRefs !== undefined) {
    if (!Array.isArray(manifest.artifactRefs)) {
      artifactsVerified = false;
      errors.push('artifactRefs must be an array when provided');
    } else {
      for (const ref of manifest.artifactRefs) {
        if (!ref || typeof ref !== 'object') {
          artifactsVerified = false;
          errors.push('Invalid artifactRef entry');
          continue;
        }
        const sha = typeof ref.sha256 === 'string' ? ref.sha256.trim().toLowerCase() : '';
        if (!/^[a-f0-9]{64}$/.test(sha)) {
          artifactsVerified = false;
          errors.push('artifactRef requires a valid 64-char hex sha256');
          continue;
        }
        if (typeof ref.uri === 'string' && ref.uri.startsWith('swarm-artifact://')) {
          if (typeof context.artifactVerifier !== 'function') {
            artifactsVerified = false;
            errors.push(`Cannot verify artifact URI ${ref.uri}: artifactVerifier unavailable`);
          } else {
            const check = context.artifactVerifier(ref.uri);
            const expectedSha = String(check?.bundleSha256 ?? check?.sha256 ?? '').toLowerCase();
            if (!check?.ok || (expectedSha && expectedSha !== sha)) {
              artifactsVerified = false;
              errors.push(`Swarm artifact verification failed for ${ref.uri}`);
            }
          }
        } else if (typeof ref.path === 'string' && ref.path.trim()) {
          if (context.workspaceRoot) {
            const full = resolveInsideWorkspace(context.workspaceRoot, normalizeEvidencePath(ref.path));
            if (!full || !existsSync(full)) {
              artifactsVerified = false;
              errors.push(`artifactRef path missing inside workspace: ${ref.path}`);
            } else if (sha256File(full) !== sha) {
              artifactsVerified = false;
              errors.push(`artifactRef sha256 mismatch for ${ref.path}`);
            }
          }
        } else {
          artifactsVerified = false;
          errors.push('artifactRef must specify a verifiable uri or workspace path');
        }
      }
    }
  }

  // Requirement 10 & 11: Independent Verdict CANNOT be self-attested by the model.
  // It is accepted ONLY when context.trustedVerdict proves independent reviewer or trusted server verifier approval.
  const modelSelfAttested =
    manifest.independentVerdict === true ||
    manifest.independentVerdict === 'passed' ||
    manifest.independentVerdict === 'pass' ||
    (manifest.independentVerdict &&
      typeof manifest.independentVerdict === 'object' &&
      ['pass', 'passed', 'approved'].includes(String(manifest.independentVerdict.status ?? '').toLowerCase()));

  const trusted = context.trustedVerdict ?? null;
  const trustedValid = Boolean(
    trusted &&
      typeof trusted === 'object' &&
      ['pass', 'passed', 'approved'].includes(String(trusted.status ?? '').toLowerCase()) &&
      TRUSTED_VERDICT_SOURCES.has(String(trusted.source ?? '')) &&
      Array.isArray(trusted.evidenceRefs) &&
      trusted.evidenceRefs.length > 0,
  );

  let independentVerdictOk = true;
  if (requireIndependentVerdict) {
    independentVerdictOk = trustedValid;
    if (!independentVerdictOk) {
      errors.push(
        modelSelfAttested
          ? 'Self-attested independentVerdict rejected; requires trusted verifier or independent reviewer evidence'
          : 'Missing trusted independentVerdict with verifiable evidenceRefs',
      );
    }
  }

  const checks = {
    manifestPresent: true,
    schemaVersion: String(manifest.schemaVersion ?? '') === EVIDENCE_MANIFEST_SCHEMA_VERSION,
    bindings:
      (!expectedTaskId || String(manifest.taskId ?? '') === expectedTaskId) &&
      (!expectedAttemptId || String(manifest.attemptId ?? '') === expectedAttemptId) &&
      (expectedPlanVersion === null || Number(manifest.planVersion) === expectedPlanVersion),
    changedFiles: changedFilesOk,
    reportedChangedFiles: reportedChangedFilesOk,
    tests: testsOk,
    testCommand: testCommandOk,
    testEvidence: testEvidenceValid,
    testReceiptVerified,
    artifactsVerified,
    independentVerdict: independentVerdictOk,
  };

  const valid = Object.values(checks).every(Boolean) && missingFields.length === 0 && errors.length === 0;
  const status = valid
    ? EVIDENCE_STATUSES.VALID
    : missingFields.length > 0
      ? EVIDENCE_STATUSES.INCOMPLETE
      : EVIDENCE_STATUSES.INVALID;

  return {
    valid,
    status,
    missingFields: [...new Set(missingFields)],
    errors: [...new Set(errors)],
    checks,
    manifest,
    source: extracted.source,
    independentVerdictSource: trustedValid ? trusted.source : null,
  };
}

export { STATUSES };
