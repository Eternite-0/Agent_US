import { createHash } from 'node:crypto';

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

/**
 * Validates a Reviewer turn output together with actual SQLite tool_receipts
 * and upstream evidence manifest to enforce schema compliance, read-only
 * behavior, mandatory artifact reads, and zero evidence tampering.
 */
export function validateReviewerExecution({
  rawText,
  reviewerEvidence = null,
  toolReceipts = [],
  originalRawText = null,
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

  return {
    valid: true,
    code: null,
    status: parsed.status,
    verdict: parsed.normalized,
    rawJsonText: parsed.rawJsonText,
    errors: [],
    readArtifactCount: readArtifactReceipts.length,
    writeViolationCount: 0,
    evidenceDigest: expectedDigest,
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
