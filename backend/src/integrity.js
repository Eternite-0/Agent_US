import { createHash, timingSafeEqual } from 'node:crypto';

export const LEDGER_INTEGRITY_ALGORITHM = 'agent-us-ledger-jcs-sha256-v1';
export const COLD_TAIL_ROWS = 32;
export const INTEGRITY_PAGE_SIZE = 500;

const DIGEST_RE = /^[0-9a-f]{64}$/;

/**
 * RFC 8785 JSON Canonicalization Scheme (JCS).
 * Deterministic serialization across object key ordering and IEEE-754 numbers.
 */
export function canonicalJson(value) {
  if (value === null) return 'null';
  const type = typeof value;
  if (type === 'boolean') return value ? 'true' : 'false';
  if (type === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('JCS cannot serialize non-finite numbers');
    }
    return Object.is(value, -0) ? '0' : JSON.stringify(value);
  }
  if (type === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    const parts = [];
    for (let i = 0; i < value.length; i++) {
      const item = value[i];
      parts.push(
        item === undefined || typeof item === 'function' || typeof item === 'symbol'
          ? 'null'
          : canonicalJson(item),
      );
    }
    return `[${parts.join(',')}]`;
  }
  if (type === 'object') {
    if (typeof value.toJSON === 'function') {
      return canonicalJson(value.toJSON());
    }
    const keys = Object.keys(value).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const parts = [];
    for (const k of keys) {
      const v = value[k];
      if (v === undefined || typeof v === 'function' || typeof v === 'symbol') {
        continue;
      }
      parts.push(`${JSON.stringify(k)}:${canonicalJson(v)}`);
    }
    return `{${parts.join(',')}}`;
  }
  throw new TypeError(`JCS cannot serialize type: ${type}`);
}

export function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function sameDigest(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

export function computeEventDigest({
  mode,
  legacyThroughSeq = 0,
  previousDigest = null,
  event,
}) {
  const envelope =
    mode === 'anchor'
      ? {
          algorithm: LEDGER_INTEGRITY_ALGORITHM,
          legacyThroughSeq,
          event,
        }
      : {
          algorithm: LEDGER_INTEGRITY_ALGORITHM,
          previousDigest,
          event,
        };
  return sha256Hex(canonicalJson(envelope));
}

export function eventMaterial(row) {
  return {
    seq: row.seq,
    timestamp: row.timestamp,
    type: row.type,
    projectId: row.projectId ?? null,
    taskId: row.taskId ?? null,
    payload:
      typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload,
  };
}

/**
 * Verifies a contiguous slice of ledger rows against `initial` state.
 * When `hash` is false, checks sequence contiguity, legacy ordering, and chain linkage
 * without recomputing SHA-256 digests (used for cold-open prefix structure check).
 */
export function verifyIntegrityRows(
  rows,
  initial = { lastSeq: 0, legacyThroughSeq: 0, headDigest: null },
  { hash = true, onError } = {},
) {
  const fail = (reason, seq) => {
    if (onError) onError(reason, seq);
    const err = new Error(`LEDGER_INTEGRITY_FAILED: ${reason} (seq=${seq})`);
    err.code = 'LEDGER_INTEGRITY_FAILED';
    err.status = 500;
    err.detail = { reason, seq };
    throw err;
  };

  let state = { ...initial };
  for (const row of rows) {
    if (row.seq !== state.lastSeq + 1) {
      fail('ledger sequence is not contiguous', row.seq);
    }
    const mode = row.integrity_mode ?? null;
    const prev = row.integrity_prev ?? null;
    const digest = row.integrity_digest ?? null;

    if (!mode) {
      if (state.headDigest !== null) {
        fail('legacy row follows protected history', row.seq);
      }
      if (prev !== null || digest !== null) {
        fail('legacy row carries unexpected integrity metadata', row.seq);
      }
      state = {
        lastSeq: row.seq,
        legacyThroughSeq: row.seq,
        headDigest: null,
      };
      continue;
    }

    if (!digest || !DIGEST_RE.test(digest)) {
      fail('malformed ledger digest', row.seq);
    }

    let event;
    try {
      event = eventMaterial(row);
    } catch {
      fail('stored event payload is not valid JSON', row.seq);
    }

    if (mode === 'anchor') {
      if (state.headDigest !== null || prev !== null) {
        fail('invalid ledger anchor position', row.seq);
      }
      if (hash) {
        const expected = computeEventDigest({
          mode: 'anchor',
          legacyThroughSeq: state.legacyThroughSeq,
          event,
        });
        if (!sameDigest(digest, expected)) {
          fail('ledger anchor digest mismatch', row.seq);
        }
      }
    } else if (mode === 'chain') {
      if (
        state.headDigest === null ||
        prev === null ||
        !DIGEST_RE.test(prev) ||
        !sameDigest(prev, state.headDigest)
      ) {
        fail('ledger chain predecessor mismatch', row.seq);
      }
      if (hash) {
        const expected = computeEventDigest({
          mode: 'chain',
          previousDigest: prev,
          event,
        });
        if (!sameDigest(digest, expected)) {
          fail('ledger chain digest mismatch', row.seq);
        }
      }
    } else {
      fail(`unknown ledger integrity mode: ${mode}`, row.seq);
    }

    state = {
      ...state,
      lastSeq: row.seq,
      headDigest: digest,
    };
  }
  return state;
}
