import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';

export const HIDDEN_ENVELOPE_BEGIN = '<<<AGENT_US_HIDDEN_ENVELOPE_V1>>>';
export const HIDDEN_ENVELOPE_END = '<<<END_AGENT_US_HIDDEN_ENVELOPE_V1>>>';
export const HIDDEN_ENVELOPE_SCHEMA_VERSION = 1;

const MAX_ARTIFACT_HASH_FILE_BYTES = 16 * 1024 * 1024;

export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? 'null' : canonicalJson(item))).join(',')}]`;
  }
  const keys = Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

export function computeSha256Hex(input) {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * Computes a deterministic SHA-256 digest over workspace files without following symlinks.
 * Excludes `.git/` metadata so cross-platform stat/index timing does not perturb digests,
 * while hashing every regular file and symlink target in sorted POSIX relative order.
 */
export function computeWorkspaceArtifactDigest(workspaceRoot) {
  const hash = createHash('sha256');
  const walk = (absDir, relPrefix) => {
    const entries = readdirSync(absDir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    for (const ent of entries) {
      if (!relPrefix && ent.name === '.git') continue;
      const rel = relPrefix ? `${relPrefix}/${ent.name}` : ent.name;
      const full = join(absDir, ent.name);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) {
        hash.update(`S:${rel}:${readlinkSync(full)}\0`);
      } else if (st.isDirectory()) {
        hash.update(`D:${rel}\0`);
        walk(full, rel);
      } else if (st.isFile()) {
        hash.update(`F:${rel}:${st.size}:`);
        if (st.size <= MAX_ARTIFACT_HASH_FILE_BYTES) {
          hash.update(readFileSync(full));
        } else {
          hash.update(`oversize:${st.size}`);
        }
        hash.update('\0');
      } else {
        hash.update(`O:${rel}\0`);
      }
    }
  };
  walk(workspaceRoot, '');
  return hash.digest('hex');
}

function unescapeJsQuotedLiteral(raw, quote) {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    i++;
    if (i >= raw.length) break;
    const esc = raw[i];
    if (esc === 'n') out += '\n';
    else if (esc === 'r') out += '\r';
    else if (esc === 't') out += '\t';
    else if (esc === 'b') out += '\b';
    else if (esc === 'f') out += '\f';
    else if (esc === 'v') out += '\v';
    else if (esc === '0') out += '\0';
    else if (esc === '\\' || esc === quote || esc === '`') out += esc;
    else if (esc === 'x' && /^[0-9a-fA-F]{2}/.test(raw.slice(i + 1, i + 3))) {
      out += String.fromCharCode(parseInt(raw.slice(i + 1, i + 3), 16));
      i += 2;
    } else if (esc === 'u') {
      if (raw[i + 1] === '{') {
        const end = raw.indexOf('}', i + 2);
        if (end > i + 2) {
          out += String.fromCodePoint(parseInt(raw.slice(i + 2, end), 16));
          i = end;
        }
      } else if (/^[0-9a-fA-F]{4}/.test(raw.slice(i + 1, i + 5))) {
        out += String.fromCharCode(parseInt(raw.slice(i + 1, i + 5), 16));
        i += 4;
      }
    } else {
      out += esc;
    }
  }
  return out;
}

function skipWhitespaceAndComments(src, idx) {
  const n = src.length;
  while (idx < n) {
    const ch = src[idx];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      idx++;
      continue;
    }
    if (ch === '/' && src[idx + 1] === '/') {
      idx += 2;
      while (idx < n && src[idx] !== '\n') idx++;
      continue;
    }
    if (ch === '/' && src[idx + 1] === '*') {
      const end = src.indexOf('*/', idx + 2);
      idx = end === -1 ? n : end + 2;
      continue;
    }
    break;
  }
  return idx;
}

/**
 * Extracts declared top-level `test('...')` / `it('...')` cases statically from a hidden acceptance script.
 * Fails closed if the script declares 0 tests or uses static skip/todo annotations unless overridden explicitly.
 */
export function extractExpectedTestsFromScript(scriptSource) {
  const src = String(scriptSource ?? '');
  const directiveMatch = src.match(/\/\/\s*AGENT_US_EXPECTED_TESTS\s*:\s*(\[[^\r\n]+\])/);
  if (directiveMatch) {
    const parsed = JSON.parse(directiveMatch[1]);
    return normalizeExpectedTests(parsed, src, { allowEmptyCheck: false });
  }

  const found = [];
  const n = src.length;
  let braceDepth = 0;

  for (let i = 0; i < n; ) {
    const ch = src[i];

    // Skip single-line comment
    if (ch === '/' && src[i + 1] === '/') {
      i += 2;
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    // Skip block comment
    if (ch === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    // Skip string literals
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      i++;
      while (i < n) {
        if (src[i] === '\\') {
          i += 2;
          continue;
        }
        if (src[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (ch === '{') {
      braceDepth++;
      i++;
      continue;
    }
    if (ch === '}') {
      braceDepth = Math.max(0, braceDepth - 1);
      i++;
      continue;
    }

    if (braceDepth === 0 && (ch === 't' || ch === 'i')) {
      const prev = i > 0 ? src[i - 1] : '';
      const isIdentStart = !/[A-Za-z0-9_$.]/.test(prev);
      if (isIdentStart) {
        let keyword = null;
        if (src.startsWith('test', i) && !/[A-Za-z0-9_$]/.test(src[i + 4] ?? '')) {
          keyword = 'test';
        } else if (src.startsWith('it', i) && !/[A-Za-z0-9_$]/.test(src[i + 2] ?? '')) {
          keyword = 'it';
        }
        if (keyword) {
          let cursor = skipWhitespaceAndComments(src, i + keyword.length);
          let mod = null;
          if (src[cursor] === '.') {
            const modStart = skipWhitespaceAndComments(src, cursor + 1);
            const modMatch = src.slice(modStart).match(/^(skip|todo|only)\b/);
            if (modMatch) {
              mod = modMatch[1];
              cursor = skipWhitespaceAndComments(src, modStart + mod.length);
            }
          }
          if (src[cursor] === '(') {
            const argStart = skipWhitespaceAndComments(src, cursor + 1);
            const q = src[argStart];
            if (q === "'" || q === '"' || q === '`') {
              let j = argStart + 1;
              let rawLiteral = '';
              let closed = false;
              let hasTemplateExpr = false;
              while (j < n) {
                if (src[j] === '\\') {
                  rawLiteral += src.slice(j, j + 2);
                  j += 2;
                  continue;
                }
                if (q === '`' && src[j] === '$' && src[j + 1] === '{') {
                  hasTemplateExpr = true;
                }
                if (src[j] === q) {
                  closed = true;
                  j++;
                  break;
                }
                rawLiteral += src[j];
                j++;
              }
              if (closed && !hasTemplateExpr) {
                const name = unescapeJsQuotedLiteral(rawLiteral, q);
                found.push({
                  index: found.length,
                  id: `test-${found.length}`,
                  name,
                  minAssertions: 1,
                  staticModifier: mod,
                });
                i = j;
                continue;
              }
            }
          }
        }
      }
    }

    i++;
  }

  return found;
}

export function normalizeExpectedTests(expectedTests, scriptSource = '', { allowEmptyCheck = false } = {}) {
  const rawList = Array.isArray(expectedTests)
    ? expectedTests
    : extractExpectedTestsFromScript(scriptSource);

  if (!Array.isArray(rawList) || (!allowEmptyCheck && rawList.length === 0)) {
    const err = new Error('Hidden acceptance suite must declare at least one expected test');
    err.code = 'E_HIDDEN_ACCEPTANCE_EMPTY';
    throw err;
  }

  return rawList.map((entry, idx) => {
    const item = typeof entry === 'string' ? { name: entry } : entry ?? {};
    const name = String(item.name ?? '').trim();
    if (!name) {
      const err = new Error(`Expected hidden test at index ${idx} is missing a valid name`);
      err.code = 'E_HIDDEN_ACCEPTANCE_POLICY';
      throw err;
    }
    const minAssertions = Number.isInteger(item.minAssertions)
      ? Math.max(0, item.minAssertions)
      : 1;
    return {
      index: idx,
      id: item.id ? String(item.id) : `test-${idx}`,
      name,
      minAssertions,
      staticModifier: item.staticModifier ?? null,
    };
  });
}

export function signHiddenEnvelope({ payload, hmacKey }) {
  const sig = createHmac('sha256', hmacKey)
    .update(canonicalJson(payload), 'utf8')
    .digest('hex');
  return {
    payload,
    algorithm: 'hmac-sha256',
    signature: sig,
  };
}

export function verifyHiddenEnvelopeSignature({ envelope, hmacKey }) {
  if (
    !envelope ||
    typeof envelope !== 'object' ||
    !envelope.payload ||
    typeof envelope.payload !== 'object' ||
    envelope.algorithm !== 'hmac-sha256' ||
    typeof envelope.signature !== 'string' ||
    !/^[0-9a-f]{64}$/i.test(envelope.signature)
  ) {
    return false;
  }
  const expectedHex = createHmac('sha256', hmacKey)
    .update(canonicalJson(envelope.payload), 'utf8')
    .digest('hex');
  const a = Buffer.from(envelope.signature.toLowerCase(), 'utf8');
  const b = Buffer.from(expectedHex, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Extracts and cryptographically verifies the supervisor's HMAC-signed hidden acceptance envelope.
 * Rejects forged stdout/stderr markers, missing envelopes, test skips, premature exits,
 * assertion bypasses, and context/digest mismatches.
 */
export function extractAndVerifyHiddenEnvelope({
  stdout = '',
  stderr = '',
  hmacKey,
  expected,
}) {
  const fail = (reason, extra = {}) => ({
    verified: false,
    passed: false,
    reason,
    tamperingDetected: Boolean(extra.tamperingDetected),
    expectedCount: expected?.expectedTests?.length ?? 0,
    executedCount: extra.executedCount ?? 0,
    passedCount: extra.passedCount ?? 0,
    failedCount: extra.failedCount ?? 0,
    skippedCount: extra.skippedCount ?? 0,
    todoCount: extra.todoCount ?? 0,
    tests: extra.tests ?? [],
    errors: extra.errors ?? [reason],
    envelopeDigest: extra.envelopeDigest ?? null,
  });

  const combinedStreams = [String(stdout ?? ''), String(stderr ?? '')];
  const blockRe = new RegExp(
    `${HIDDEN_ENVELOPE_BEGIN}\\s*([\\s\\S]*?)\\s*${HIDDEN_ENVELOPE_END}`,
    'g',
  );

  const validEnvelopes = [];
  for (const streamText of combinedStreams) {
    let matchedRanges = 0;
    const stripped = streamText.replace(blockRe, (_full, body) => {
      matchedRanges++;
      let parsed;
      try {
        parsed = JSON.parse(body.trim());
      } catch {
        return '__INVALID_ENVELOPE__';
      }
      if (!verifyHiddenEnvelopeSignature({ envelope: parsed, hmacKey })) {
        return '__INVALID_ENVELOPE__';
      }
      validEnvelopes.push(parsed);
      return '';
    });

    if (
      stripped.includes('__INVALID_ENVELOPE__') ||
      stripped.includes(HIDDEN_ENVELOPE_BEGIN) ||
      stripped.includes(HIDDEN_ENVELOPE_END)
    ) {
      return fail('forged_or_corrupted_envelope', { tamperingDetected: true });
    }
    if (matchedRanges > 0 && validEnvelopes.length === 0) {
      return fail('forged_or_corrupted_envelope', { tamperingDetected: true });
    }
  }

  if (validEnvelopes.length === 0) {
    return fail('missing_completion_envelope');
  }
  if (validEnvelopes.length > 1) {
    return fail('duplicate_envelopes', { tamperingDetected: true });
  }

  const envelope = validEnvelopes[0];
  const payload = envelope.payload;
  const envelopeDigest = computeSha256Hex(canonicalJson(envelope));
  const errors = [];

  if (payload.schemaVersion !== HIDDEN_ENVELOPE_SCHEMA_VERSION) {
    errors.push(`unexpected envelope schemaVersion: ${String(payload.schemaVersion)}`);
  }
  if (payload.envelopeNonce !== expected.envelopeNonce) {
    errors.push('envelopeNonce mismatch');
  }
  if (payload.sessionNonce !== expected.sessionNonce) {
    errors.push('sessionNonce mismatch');
  }
  if (payload.taskId !== expected.taskId) {
    errors.push(`taskId mismatch: expected ${expected.taskId}, got ${String(payload.taskId)}`);
  }
  if (payload.attemptId !== expected.attemptId) {
    errors.push(`attemptId mismatch: expected ${expected.attemptId}, got ${String(payload.attemptId)}`);
  }
  if (payload.artifactDigest !== expected.artifactDigest) {
    errors.push('artifactDigest mismatch');
  }
  if (payload.suiteSha256 !== expected.suiteSha256) {
    errors.push('suiteSha256 mismatch');
  }
  if (payload.workerSha256 !== expected.workerSha256) {
    errors.push('workerSha256 mismatch');
  }
  if (payload.started !== true) {
    errors.push('missing acceptance start attestation');
  }
  if (payload.completed !== true) {
    errors.push('missing acceptance completion attestation');
  }
  if (payload.tamperingDetected) {
    errors.push('supervisor detected tampering attempt');
  }

  const expectedTests = expected.expectedTests ?? [];
  const actualTests = Array.isArray(payload.tests) ? payload.tests : [];
  if (payload.expectedCount !== expectedTests.length || actualTests.length !== expectedTests.length) {
    errors.push(
      `expected test count mismatch: expected ${expectedTests.length}, executed records ${actualTests.length}`,
    );
  }

  for (let i = 0; i < expectedTests.length; i++) {
    const exp = expectedTests[i];
    const act = actualTests[i];
    if (!act || typeof act !== 'object') {
      errors.push(`missing execution record for test[${i}] "${exp.name}"`);
      continue;
    }
    if (act.index !== i || act.id !== exp.id || act.name !== exp.name) {
      errors.push(`test[${i}] identity mismatch: expected "${exp.name}", got "${String(act.name)}"`);
    }
    if (act.started !== true || act.completed !== true) {
      errors.push(`test "${exp.name}" did not start and complete cleanly (${act.reason ?? 'incomplete'})`);
    }
    if (act.skipped || act.todo) {
      errors.push(`test "${exp.name}" was skipped or marked todo`);
    }
    if (act.prematureExit) {
      errors.push(`test "${exp.name}" terminated worker prematurely before completion`);
    }
    if (act.workerExitCode !== 0 || act.workerSignal != null) {
      errors.push(
        `test "${exp.name}" worker exited abnormally (code=${String(act.workerExitCode)}, signal=${String(act.workerSignal)})`,
      );
    }
    if (!Number.isInteger(act.assertionCount) || act.assertionCount < (exp.minAssertions ?? 1)) {
      errors.push(
        `test "${exp.name}" ran insufficient assertions (${String(act.assertionCount)} < ${exp.minAssertions ?? 1})`,
      );
    }
    if (act.passed !== true) {
      errors.push(`test "${exp.name}" failed: ${act.error ?? act.reason ?? 'failed'}`);
    }
  }

  if (payload.executedCount !== expectedTests.length) {
    errors.push(`executedCount ${String(payload.executedCount)} !== ${expectedTests.length}`);
  }
  if (payload.passedCount !== expectedTests.length) {
    errors.push(`passedCount ${String(payload.passedCount)} !== ${expectedTests.length}`);
  }
  if ((payload.failedCount ?? 0) !== 0) {
    errors.push(`failedCount is ${String(payload.failedCount)}`);
  }
  if ((payload.skippedCount ?? 0) !== 0) {
    errors.push(`skippedCount is ${String(payload.skippedCount)}`);
  }
  if ((payload.todoCount ?? 0) !== 0) {
    errors.push(`todoCount is ${String(payload.todoCount)}`);
  }

  const verified = errors.length === 0;
  let failureReason = 'none';
  if (!verified) {
    if (payload.tamperingDetected) failureReason = 'tampering_detected';
    else if (actualTests.some((t) => t?.reason === 'worker_timeout')) {
      failureReason = 'worker_timeout';
    } else if (actualTests.some((t) => t?.prematureExit)) failureReason = 'premature_exit';
    else if ((payload.skippedCount ?? 0) > 0 || (payload.todoCount ?? 0) > 0) {
      failureReason = 'skipped_or_todo_test';
    } else if (
      payload.expectedCount !== expectedTests.length ||
      payload.executedCount !== expectedTests.length ||
      actualTests.length !== expectedTests.length
    ) {
      failureReason = 'test_count_mismatch';
    } else if (errors.some((e) => e.includes('insufficient assertions'))) {
      failureReason = 'insufficient_assertions';
    } else {
      failureReason = 'hidden_acceptance_failed';
    }
  }

  return {
    verified,
    passed: verified,
    reason: failureReason,
    tamperingDetected: Boolean(payload.tamperingDetected),
    expectedCount: expectedTests.length,
    executedCount: Number.isInteger(payload.executedCount) ? payload.executedCount : actualTests.length,
    passedCount: Number.isInteger(payload.passedCount) ? payload.passedCount : 0,
    failedCount: Number.isInteger(payload.failedCount) ? payload.failedCount : 0,
    skippedCount: Number.isInteger(payload.skippedCount) ? payload.skippedCount : 0,
    todoCount: Number.isInteger(payload.todoCount) ? payload.todoCount : 0,
    tests: actualTests,
    errors,
    envelopeDigest,
  };
}
