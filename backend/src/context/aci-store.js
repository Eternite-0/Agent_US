import { createHash } from 'node:crypto';
import { estimateTokens } from '../context.js';
import { Fault } from '../store.js';

function sha256Hex(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex');
}

const VALID_DECISION_TAGS = new Set([
  'DIRECT',
  'SUPPORTING',
  'DEFER',
  'DUPLICATE',
  'IRRELEVANT',
]);

export function normalizeContextPath(rawPath) {
  if (typeof rawPath !== 'string') return '';
  let p = rawPath.trim().replace(/\\/g, '/');
  if (!p) return '';
  while (p.startsWith('./')) p = p.slice(2);
  p = p.replace(/\/{2,}/g, '/');
  const isAbs = p.startsWith('/');
  const driveMatch = p.match(/^([A-Za-z]:)(\/.*)?$/);
  const drivePrefix = driveMatch ? driveMatch[1] : '';
  const rest = driveMatch ? (driveMatch[2] ?? '') : p;
  const parts = [];
  for (const seg of rest.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (parts.length && parts.at(-1) !== '..') parts.pop();
      else if (!isAbs && !drivePrefix) parts.push('..');
    } else {
      parts.push(seg);
    }
  }
  let norm =
    (drivePrefix || (isAbs ? '/' : '')) +
    (drivePrefix && rest.startsWith('/') ? '/' : '') +
    parts.join('/');
  if (!norm || norm === '.') return '';
  if (process.platform === 'win32') norm = norm.toLowerCase();
  return norm;
}

function pathsMatch(a, b) {
  const na = normalizeContextPath(a);
  const nb = normalizeContextPath(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.endsWith(`/${nb}`) || nb.endsWith(`/${na}`)) return true;
  return false;
}

function normalizeSymbolOutline(symbolOutline) {
  if (Array.isArray(symbolOutline)) {
    return symbolOutline
      .map((s) => String(s ?? '').trim())
      .filter(Boolean)
      .slice(0, 16);
  }
  if (typeof symbolOutline === 'string' && symbolOutline.trim()) {
    return symbolOutline
      .split(/[,;\n]/)
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 16);
  }
  return [];
}

function normalizeLineRange(lineRange, rawText) {
  if (typeof lineRange === 'string' && lineRange.trim()) {
    return lineRange.trim();
  }
  if (lineRange && typeof lineRange === 'object') {
    const rawStart = lineRange.start ?? lineRange.from ?? 1;
    const rawEnd = lineRange.end ?? lineRange.to;
    const start = rawStart !== null && rawStart !== '' ? Number(rawStart) : NaN;
    const end = rawEnd !== null && rawEnd !== undefined && rawEnd !== '' ? Number(rawEnd) : NaN;
    if (Number.isFinite(start)) {
      return Number.isFinite(end) ? `L${start}-${end}` : `L${start}-EOF`;
    }
  }
  const lineCount = String(rawText ?? '').split(/\r?\n/).length;
  return `L1-${lineCount}`;
}

function normalizeSha256Key(rawHashOrUri) {
  const clean = String(rawHashOrUri ?? '')
    .trim()
    .replace(/^artifact:\/\//i, '')
    .toLowerCase();
  return /^[0-9a-f]{64}$/.test(clean) ? clean : '';
}

function dedupePaths(list = []) {
  const out = [];
  const seen = new Set();
  for (const item of list ?? []) {
    const clean = String(item ?? '').trim();
    const norm = normalizeContextPath(clean);
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    out.push(clean);
  }
  return out;
}

/**
 * Formats the compact reversible ACI reference stub for an admitted or aged tool output.
 */
export function formatAciRefStub(ref, opts = {}) {
  const rawDecision = String(opts.decision ?? ref?.decision ?? 'DEFER')
    .trim()
    .toUpperCase();
  const decision = VALID_DECISION_TAGS.has(rawDecision) ? rawDecision : 'DEFER';
  const uri = String(ref?.uri || (ref?.sha256 ? `artifact://${ref.sha256}` : 'artifact://unknown'));
  const pathPart = String(ref?.path || ref?.toolName || 'output')
    .replace(/[|\r\n]+/g, ' ')
    .trim()
    .slice(0, opts.compact === true ? 96 : 240);
  const linesPart = String(ref?.lineRange || 'L1-EOF')
    .replace(/[|\r\n]+/g, ' ')
    .trim();
  const symbolsList = normalizeSymbolOutline(opts.symbolOutline ?? ref?.symbolOutline);
  const symbolsPart = symbolsList.length
    ? symbolsList.slice(0, 10).join(', ').slice(0, 140)
    : '-';
  const tok = Math.max(1, Number(ref?.originalTokens || 0));
  const priorStep = opts.priorStep ?? ref?.priorStep ?? null;
  const priorPart =
    decision === 'DUPLICATE' && priorStep != null && Number.isFinite(Number(priorStep))
      ? ` | prior step=${Number(priorStep)}`
      : '';
  if (decision === 'IRRELEVANT') {
    return opts.compact === true
      ? `[ACI-SKIP ${uri} | IRRELEVANT | ${pathPart} | ~${tok} tok | omitted noise]`
      : `[ACI-SKIP ${uri} | IRRELEVANT | ${pathPart} | ${linesPart} | ~${tok} tok | omitted: non-target/archived noise — do NOT expand unless explicitly required]`;
  }
  if (decision === 'DUPLICATE') {
    return opts.compact === true
      ? `[ACI-SKIP ${uri} | DUPLICATE | ${pathPart} | ~${tok} tok${priorPart} | duplicate]`
      : `[ACI-SKIP ${uri} | DUPLICATE | ${pathPart} | ${linesPart} | ~${tok} tok${priorPart} | already in context — no need to re-read or expand]`;
  }
  const restoreCall = `expand_context({ ref: "${uri}", startLine, endLine })`;
  if (opts.compact === true) {
    return `[ACI-REF ${uri} | ${decision} | ${pathPart} | ${linesPart} | ~${tok} tok${priorPart} | ${restoreCall}]`;
  }
  return `[ACI-REF ${uri} | ${decision} | ${pathPart} | ${linesPart} | ${symbolsPart} | ~${tok} tok${priorPart} | restore: ${restoreCall} | call expand_context or read_blob to restore]`;
}

/**
 * ReversibleContextStore wraps `store.putBlob`/`store.getBlob` (`artifact://...`)
 * with structured metadata refs, SHA-256 hash verification, and 100% lossless restoration.
 */
export class ReversibleContextStore {
  #memoryBlobs = new Map();
  #refsById = new Map();
  #refsByUri = new Map();
  #directHashes = new Map(); // normPath -> { uri, sha256, path, lineRange, step, bytes, chars, registeredAt }
  #directByUri = new Map(); // uri -> latest direct entry
  #seq = 0;

  constructor(store = null) {
    this.store = store;
  }

  #writeBlob(raw) {
    if (this.store && typeof this.store.putBlob === 'function') {
      const saved = this.store.putBlob(raw);
      return {
        sha256: saved.sha256,
        uri: saved.uri || `artifact://${saved.sha256}`,
        bytes: saved.bytes ?? Buffer.byteLength(raw, 'utf8'),
      };
    }
    const sha256 = sha256Hex(raw);
    const uri = `artifact://${sha256}`;
    if (!this.#memoryBlobs.has(sha256)) {
      this.#memoryBlobs.set(sha256, raw);
    }
    return {
      sha256,
      uri,
      bytes: Buffer.byteLength(raw, 'utf8'),
    };
  }

  #readBlob(sha256OrUri) {
    const clean = String(sha256OrUri || '').trim();
    const key = clean.replace(/^artifact:\/\//, '');
    if (!key) {
      throw new Fault('ARTIFACT_NOT_FOUND', 404, { message: 'Missing artifact URI or refId' });
    }
    if (this.store && typeof this.store.getBlob === 'function') {
      try {
        const row = this.store.getBlob(clean.startsWith('artifact://') ? clean : `artifact://${key}`);
        if (row && typeof row.content === 'string') return row.content;
      } catch (err) {
        if (!this.#memoryBlobs.has(key)) throw err;
      }
    }
    if (this.#memoryBlobs.has(key)) {
      return this.#memoryBlobs.get(key);
    }
    throw new Fault('ARTIFACT_NOT_FOUND', 404, { message: `Artifact not found: ${sha256OrUri}` });
  }

  /**
   * Registers a DIRECT-injected payload's content hash without adding an
   * offloaded ref to `listRefs()`, enabling deterministic DUPLICATE detection
   * and verified restoration if referenced later.
   */
  registerDirectHash(rawText, meta = {}) {
    const raw = typeof rawText === 'string' ? rawText : String(rawText ?? '');
    const saved = this.#writeBlob(raw);
    const path = String(meta.path || '').trim().replace(/\\/g, '/');
    const normPath = normalizeContextPath(path);
    const step =
      meta.step != null && meta.step !== '' && Number.isFinite(Number(meta.step))
        ? Math.max(0, Math.trunc(Number(meta.step)))
        : 0;
    const entry = {
      refId: null,
      uri: saved.uri,
      sha256: saved.sha256,
      toolName: String(meta.toolName || 'read_file').trim(),
      path,
      lineRange: normalizeLineRange(meta.lineRange, raw),
      symbolOutline: normalizeSymbolOutline(meta.symbolOutline),
      originalTokens:
        meta.originalTokens != null && meta.originalTokens !== '' && Number.isFinite(Number(meta.originalTokens))
          ? Number(meta.originalTokens)
          : estimateTokens(raw),
      step,
      decision: 'DIRECT',
      bytes: saved.bytes,
      chars: raw.length,
      active: true,
      registeredAt: Date.now(),
    };
    if (normPath) {
      this.#directHashes.set(normPath, entry);
    }
    this.#directByUri.set(entry.uri, entry);
    return { ...entry };
  }

  /**
   * Marks previously tracked active hashes for a mutated path inactive so
   * post-edit re-reads are never classified as DUPLICATE.
   */
  invalidatePath(rawPath) {
    const norm = normalizeContextPath(rawPath);
    if (!norm) return;
    for (const [k, entry] of this.#directHashes.entries()) {
      if (pathsMatch(k, norm) || pathsMatch(entry.path, norm)) {
        this.#directHashes.delete(k);
      }
    }
    for (const ref of this.#refsById.values()) {
      if (ref.path && pathsMatch(ref.path, norm)) {
        ref.active = false;
      }
    }
  }

  /**
   * Persists exact raw text into the content-addressed blob store and creates
   * a structured ACI reference record.
   */
  put(rawText, meta = {}) {
    const raw = typeof rawText === 'string' ? rawText : String(rawText ?? '');
    const saved = this.#writeBlob(raw);
    this.#seq += 1;
    const refId = String(meta.refId || `aci_${this.#seq}_${saved.sha256.slice(0, 8)}`);
    const originalTokens =
      meta.originalTokens != null && meta.originalTokens !== '' && Number.isFinite(Number(meta.originalTokens))
        ? Number(meta.originalTokens)
        : estimateTokens(raw);
    const symbolOutline = normalizeSymbolOutline(meta.symbolOutline);
    const lineRange = normalizeLineRange(meta.lineRange, raw);
    const path = String(meta.path || '').trim().replace(/\\/g, '/');
    const toolName = String(meta.toolName || 'tool').trim();
    const step =
      meta.step != null && meta.step !== '' && Number.isFinite(Number(meta.step))
        ? Math.max(0, Math.trunc(Number(meta.step)))
        : 0;
    const rawDecision = meta.decision ? String(meta.decision).trim().toUpperCase() : null;
    const decision = rawDecision && VALID_DECISION_TAGS.has(rawDecision) ? rawDecision : null;
    const priorStep =
      meta.priorStep != null && meta.priorStep !== '' && Number.isFinite(Number(meta.priorStep))
        ? Math.max(0, Math.trunc(Number(meta.priorStep)))
        : null;

    const ref = {
      refId,
      uri: saved.uri,
      sha256: saved.sha256,
      toolName,
      path,
      lineRange,
      symbolOutline,
      originalTokens,
      stubTokens: 0,
      step,
      decision,
      priorStep,
      active: meta.active !== false,
      restoredCount: 0,
      bytes: saved.bytes,
      chars: raw.length,
      createdAt: Date.now(),
    };
    const stubText = formatAciRefStub(ref, meta);
    ref.stubTokens = estimateTokens(stubText);

    this.#refsById.set(ref.refId, ref);
    const existingList = this.#refsByUri.get(ref.uri) ?? [];
    existingList.push(ref);
    this.#refsByUri.set(ref.uri, existingList);

    return { ...ref, stubText };
  }

  /**
   * Alias for put(rawText, meta).
   */
  spill(rawText, meta = {}) {
    return this.put(rawText, meta);
  }

  /**
   * Alias for put(rawText, meta).
   */
  saveRef(rawText, meta = {}) {
    return this.put(rawText, meta);
  }

  /**
   * Returns structured metadata for a refId or artifact:// URI / sha256.
   */
  getRef(uriOrRefId) {
    const key = String(uriOrRefId ?? '').trim();
    if (!key) return null;
    if (this.#refsById.has(key)) {
      return { ...this.#refsById.get(key) };
    }
    const uri = key.startsWith('artifact://')
      ? key
      : /^[0-9a-f]{64}$/i.test(key)
        ? `artifact://${key.toLowerCase()}`
        : null;
    if (uri && this.#refsByUri.has(uri)) {
      const list = this.#refsByUri.get(uri);
      if (list?.length) return { ...list[list.length - 1] };
    }
    if (uri && this.#directByUri.has(uri)) {
      return { ...this.#directByUri.get(uri) };
    }
    return null;
  }

  listRefs() {
    return [...this.#refsById.values()].map((r) => ({ ...r }));
  }

  /**
   * Deterministic lookup by path and SHA-256 for exact DUPLICATE detection.
   */
  findByPathAndHash(path, sha256) {
    const normTarget = normalizeContextPath(path);
    const hashKey = normalizeSha256Key(sha256);
    if (!normTarget || !hashKey) return null;

    const allRefs = [...this.#refsById.values()];
    for (let i = allRefs.length - 1; i >= 0; i -= 1) {
      const ref = allRefs[i];
      if (
        ref.active !== false &&
        ref.sha256?.toLowerCase() === hashKey &&
        ref.path &&
        pathsMatch(ref.path, normTarget)
      ) {
        return { ...ref };
      }
    }

    for (const entry of this.#directHashes.values()) {
      if (
        entry.active !== false &&
        entry.sha256?.toLowerCase() === hashKey &&
        entry.path &&
        pathsMatch(entry.path, normTarget)
      ) {
        return { ...entry };
      }
    }
    return null;
  }

  /**
   * Deterministic lookup of any active tracked artifact matching the SHA-256.
   */
  findActiveByHash(sha256) {
    const hashKey = normalizeSha256Key(sha256);
    if (!hashKey) return null;
    const uri = `artifact://${hashKey}`;
    const list = this.#refsByUri.get(uri);
    if (list?.length) {
      for (let i = list.length - 1; i >= 0; i -= 1) {
        if (list[i].active !== false) return { ...list[i] };
      }
    }
    const direct = this.#directByUri.get(uri);
    if (direct && direct.active !== false) {
      return { ...direct };
    }
    return null;
  }

  /**
   * Guarantees 100% lossless restoration of the exact original string from
   * a refId, `artifact://<sha256>` URI, or raw sha256 hex digest.
   */
  restore(uriOrRefId) {
    const key = String(uriOrRefId ?? '').trim();
    if (!key) {
      throw new Fault('ARTIFACT_NOT_FOUND', 404, { message: 'Empty refId or artifact URI' });
    }
    const refById = this.#refsById.get(key);
    if (refById) {
      const raw = this.#readBlob(refById.uri);
      refById.restoredCount += 1;
      return raw;
    }
    const uri = key.startsWith('artifact://')
      ? key
      : /^[0-9a-f]{64}$/i.test(key)
        ? `artifact://${key.toLowerCase()}`
        : key;
    const raw = this.#readBlob(uri);
    const linkedRefs = this.#refsByUri.get(uri.startsWith('artifact://') ? uri : `artifact://${uri}`);
    if (linkedRefs) {
      for (const ref of linkedRefs) ref.restoredCount += 1;
    }
    return raw;
  }

  /**
   * Cryptographically verifies restored content's SHA-256 against both
   * caller-provided `expectedSha256` and stored metadata/URI before returning.
   */
  restoreVerified(uriOrRefId, { expectedSha256 } = {}) {
    const key = String(uriOrRefId ?? '').trim();
    if (!key) {
      throw new Fault('ARTIFACT_NOT_FOUND', 404, { message: 'Empty refId or artifact URI' });
    }

    const refById = this.#refsById.get(key) ?? null;
    const resolvedUri = refById
      ? refById.uri
      : key.startsWith('artifact://')
        ? key.toLowerCase()
        : /^[0-9a-f]{64}$/i.test(key)
          ? `artifact://${key.toLowerCase()}`
          : key;
    const canonicalUri = resolvedUri.startsWith('artifact://') ? resolvedUri : `artifact://${resolvedUri}`;
    const linkedRefs = this.#refsByUri.get(canonicalUri) ?? null;
    const latestLinked = linkedRefs?.length ? linkedRefs[linkedRefs.length - 1] : null;
    const directMeta = this.#directByUri.get(canonicalUri) ?? null;
    const refMeta = refById ?? latestLinked ?? directMeta ?? null;

    const raw = this.#readBlob(refById ? refById.uri : resolvedUri);
    const actualSha256 = sha256Hex(raw);

    const callerExpected = expectedSha256 != null ? normalizeSha256Key(expectedSha256) : '';
    if (expectedSha256 != null && String(expectedSha256).trim() !== '' && !callerExpected) {
      throw new Fault('ARTIFACT_HASH_MISMATCH', 500, {
        message: 'Invalid expectedSha256 digest format',
        uri: canonicalUri,
        expectedSha256: String(expectedSha256),
        actualSha256,
      });
    }
    if (callerExpected && actualSha256 !== callerExpected) {
      throw new Fault('ARTIFACT_HASH_MISMATCH', 500, {
        message: `Artifact SHA-256 mismatch for ${key}`,
        uri: canonicalUri,
        expectedSha256: callerExpected,
        actualSha256,
      });
    }

    const storedExpected = refMeta?.sha256 ? normalizeSha256Key(refMeta.sha256) : '';
    if (storedExpected && actualSha256 !== storedExpected) {
      throw new Fault('ARTIFACT_HASH_MISMATCH', 500, {
        message: `Stored artifact SHA-256 mismatch for ${key}`,
        uri: canonicalUri,
        expectedSha256: storedExpected,
        actualSha256,
      });
    }

    const uriExpected = normalizeSha256Key(canonicalUri);
    if (uriExpected && actualSha256 !== uriExpected) {
      throw new Fault('ARTIFACT_HASH_MISMATCH', 500, {
        message: `URI artifact SHA-256 mismatch for ${key}`,
        uri: canonicalUri,
        expectedSha256: uriExpected,
        actualSha256,
      });
    }

    if (refById) {
      refById.restoredCount += 1;
    } else if (linkedRefs) {
      for (const ref of linkedRefs) ref.restoredCount += 1;
    }

    return {
      content: raw,
      sha256: actualSha256,
      verified: true,
      refId: refMeta?.refId ?? null,
      uri: refMeta?.uri ?? canonicalUri,
      path: refMeta?.path ?? '',
      bytes: Buffer.byteLength(raw, 'utf8'),
    };
  }
}

/**
 * ContextEvidenceLedger records discovered candidates, kept/compressed/expanded
 * items, pre-injection admissions, supervisor calls, hash-verified recoveries,
 * abstentions, and computes Stage 3/4 governance metrics against ground truth.
 */
export class ContextEvidenceLedger {
  constructor() {
    this.discovered = [];
    this.kept = [];
    this.compressed = [];
    this.expanded = [];
    this.abstained = [];
    this.admissions = [];
    this.supervisorCalls = [];
    this.recoveries = [];
    this.taskOutcome = null;
  }

  recordDiscovered(items) {
    const list = Array.isArray(items) ? items : [items];
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      this.discovered.push({
        refId: item.refId ?? null,
        path: item.path ? String(item.path) : '',
        score: Number.isFinite(Number(item.score)) ? Number(item.score) : 0,
        source: String(item.source || 'candidate'),
        step: Number.isFinite(Number(item.step)) ? Number(item.step) : 0,
        symbols: Array.isArray(item.symbols) ? [...item.symbols] : [],
        at: Date.now(),
      });
    }
  }

  recordKept(items) {
    const list = Array.isArray(items) ? items : [items];
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      this.kept.push({
        refId: item.refId ?? null,
        path: item.path ? String(item.path) : '',
        reason: String(item.reason || 'relevant'),
        tokens: Number(item.tokens ?? item.originalTokens ?? 0),
        step: Number.isFinite(Number(item.step)) ? Number(item.step) : 0,
        at: Date.now(),
      });
    }
  }

  recordCompressed(items) {
    const list = Array.isArray(items) ? items : [items];
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      const originalTokens = Number(item.originalTokens ?? 0);
      const stubTokens = Number(item.stubTokens ?? 0);
      this.compressed.push({
        refId: item.refId ?? null,
        uri: item.uri ?? null,
        path: item.path ? String(item.path) : '',
        originalTokens,
        stubTokens,
        tokensSaved: Math.max(0, originalTokens - stubTokens),
        step: Number.isFinite(Number(item.step)) ? Number(item.step) : 0,
        epoch: Number.isFinite(Number(item.epoch)) ? Number(item.epoch) : null,
        at: Date.now(),
      });
    }
  }

  recordExpanded(items) {
    const list = Array.isArray(items) ? items : [items];
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      this.expanded.push({
        refId: item.refId ?? null,
        uri: item.uri ?? null,
        path: item.path ? String(item.path) : '',
        level: String(item.level || 'outline'),
        tokens: Number(item.tokens ?? 0),
        step: Number.isFinite(Number(item.step)) ? Number(item.step) : 0,
        at: Date.now(),
      });
    }
  }

  recordAbstained(entry) {
    if (!entry || typeof entry !== 'object') return;
    this.abstained.push({
      query: String(entry.query || '').slice(0, 200),
      reason: String(entry.reason || 'local_context_sufficient'),
      coverage: Number.isFinite(Number(entry.coverage)) ? Number(entry.coverage) : 1,
      step: Number.isFinite(Number(entry.step)) ? Number(entry.step) : 0,
      at: Date.now(),
    });
  }

  recordAdmission(entry) {
    const list = Array.isArray(entry) ? entry : [entry];
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      const originalTokens = Math.max(0, Number(item.originalTokens ?? 0));
      const injectedTokens = Math.max(0, Number(item.injectedTokens ?? 0));
      const tokensSaved =
        item.tokensSaved != null && Number.isFinite(Number(item.tokensSaved))
          ? Math.max(0, Number(item.tokensSaved))
          : Math.max(0, originalTokens - injectedTokens);
      this.admissions.push({
        refId: item.refId ?? null,
        uri: item.uri ?? null,
        sha256: item.sha256 ?? null,
        path: item.path ? String(item.path) : '',
        toolName: String(item.toolName || 'tool'),
        decision: String(item.decision || 'DIRECT').toUpperCase(),
        criticalDomains: Array.isArray(item.criticalDomains) ? [...item.criticalDomains] : [],
        score: Number.isFinite(Number(item.score)) ? Number(item.score) : 0,
        originalTokens,
        injectedTokens,
        tokensSaved,
        step: Number.isFinite(Number(item.step)) ? Number(item.step) : 0,
        reason: String(item.reason || ''),
        at: Date.now(),
      });
    }
  }

  recordSupervisorCall(entry) {
    if (!entry || typeof entry !== 'object') return;
    const inputTokens = Math.max(0, Number(entry.inputTokens ?? 0));
    const outputTokens = Math.max(0, Number(entry.outputTokens ?? 0));
    const totalTokens =
      entry.totalTokens != null && Number.isFinite(Number(entry.totalTokens))
        ? Math.max(0, Number(entry.totalTokens))
        : inputTokens + outputTokens;
    this.supervisorCalls.push({
      stage: String(entry.stage || 'admission'),
      model: entry.model ? String(entry.model) : null,
      candidateCount: Math.max(0, Number(entry.candidateCount ?? 0)),
      decisions: entry.decisions ?? null,
      inputTokens,
      outputTokens,
      totalTokens,
      durationMs: Math.max(0, Number(entry.durationMs ?? 0)),
      ok: entry.ok !== false,
      fallback: entry.fallback ?? null,
      step: Number.isFinite(Number(entry.step)) ? Number(entry.step) : 0,
      at: Date.now(),
    });
  }

  recordRecovery(entry) {
    if (!entry || typeof entry !== 'object') return;
    this.recoveries.push({
      refId: entry.refId ?? null,
      uri: entry.uri ?? null,
      sha256: entry.sha256 ?? null,
      path: entry.path ? String(entry.path) : '',
      level: String(entry.level || 'verbatim'),
      verified: Boolean(entry.verified),
      tokensRestored: Math.max(0, Number(entry.tokensRestored ?? 0)),
      triggeredBy: String(entry.triggeredBy || 'expand_context'),
      step: Number.isFinite(Number(entry.step)) ? Number(entry.step) : 0,
      at: Date.now(),
    });
  }

  recordOutcome(outcome) {
    if (!outcome || typeof outcome !== 'object') {
      this.taskOutcome = outcome ?? null;
      return;
    }
    this.taskOutcome = { ...outcome, recordedAt: Date.now() };
  }

  /**
   * Idempotently merges another ContextEvidenceLedger (or serialized ledger snapshot)
   * into this ledger without duplicating items across mid-turn automatic retries.
   */
  mergeFrom(other) {
    if (!other || other === this || typeof other !== 'object') return this;

    const mergeUnique = (target, incoming, keyFn, cloneFn) => {
      if (!Array.isArray(incoming) || incoming.length === 0) return;
      const seen = new Set(target.map(keyFn));
      for (const item of incoming) {
        if (!item || typeof item !== 'object') continue;
        const cloned = cloneFn(item);
        const key = keyFn(cloned);
        if (seen.has(key)) continue;
        seen.add(key);
        target.push(cloned);
      }
    };

    mergeUnique(
      this.discovered,
      other.discovered,
      (x) => `${x.refId ?? ''}|${normalizeContextPath(x.path)}|${x.source ?? ''}|${x.step ?? 0}`,
      (x) => ({
        refId: x.refId ?? null,
        path: x.path ? String(x.path) : '',
        score: Number.isFinite(Number(x.score)) ? Number(x.score) : 0,
        source: String(x.source || 'candidate'),
        step: Number.isFinite(Number(x.step)) ? Number(x.step) : 0,
        symbols: Array.isArray(x.symbols) ? [...x.symbols] : [],
        at: x.at ?? 0,
      }),
    );

    mergeUnique(
      this.kept,
      other.kept,
      (x) => `${x.refId ?? ''}|${normalizeContextPath(x.path)}|${x.reason ?? ''}|${x.tokens ?? 0}|${x.step ?? 0}`,
      (x) => ({
        refId: x.refId ?? null,
        path: x.path ? String(x.path) : '',
        reason: String(x.reason || 'relevant'),
        tokens: Number(x.tokens ?? x.originalTokens ?? 0),
        step: Number.isFinite(Number(x.step)) ? Number(x.step) : 0,
        at: x.at ?? 0,
      }),
    );

    mergeUnique(
      this.compressed,
      other.compressed,
      (x) => `${x.refId ?? ''}|${x.uri ?? ''}|${normalizeContextPath(x.path)}|${x.step ?? 0}|${x.epoch ?? ''}`,
      (x) => {
        const originalTokens = Number(x.originalTokens ?? 0);
        const stubTokens = Number(x.stubTokens ?? 0);
        return {
          refId: x.refId ?? null,
          uri: x.uri ?? null,
          path: x.path ? String(x.path) : '',
          originalTokens,
          stubTokens,
          tokensSaved:
            x.tokensSaved != null && Number.isFinite(Number(x.tokensSaved))
              ? Math.max(0, Number(x.tokensSaved))
              : Math.max(0, originalTokens - stubTokens),
          step: Number.isFinite(Number(x.step)) ? Number(x.step) : 0,
          epoch: Number.isFinite(Number(x.epoch)) ? Number(x.epoch) : null,
          at: x.at ?? 0,
        };
      },
    );

    mergeUnique(
      this.expanded,
      other.expanded,
      (x) => `${x.refId ?? ''}|${x.uri ?? ''}|${normalizeContextPath(x.path)}|${x.level ?? ''}|${x.tokens ?? 0}|${x.step ?? 0}`,
      (x) => ({
        refId: x.refId ?? null,
        uri: x.uri ?? null,
        path: x.path ? String(x.path) : '',
        level: String(x.level || 'outline'),
        tokens: Number(x.tokens ?? 0),
        step: Number.isFinite(Number(x.step)) ? Number(x.step) : 0,
        at: x.at ?? 0,
      }),
    );

    mergeUnique(
      this.abstained,
      other.abstained,
      (x) => `${x.query ?? ''}|${x.reason ?? ''}|${x.step ?? 0}`,
      (x) => ({
        query: String(x.query || '').slice(0, 200),
        reason: String(x.reason || 'local_context_sufficient'),
        coverage: Number.isFinite(Number(x.coverage)) ? Number(x.coverage) : 1,
        step: Number.isFinite(Number(x.step)) ? Number(x.step) : 0,
        at: x.at ?? 0,
      }),
    );

    mergeUnique(
      this.admissions,
      other.admissions,
      (x) =>
        `${x.refId ?? ''}|${x.uri ?? ''}|${x.sha256 ?? ''}|${normalizeContextPath(x.path)}|${x.toolName ?? ''}|${x.decision ?? ''}|${x.step ?? 0}`,
      (x) => {
        const originalTokens = Math.max(0, Number(x.originalTokens ?? 0));
        const injectedTokens = Math.max(0, Number(x.injectedTokens ?? 0));
        const tokensSaved =
          x.tokensSaved != null && Number.isFinite(Number(x.tokensSaved))
            ? Math.max(0, Number(x.tokensSaved))
            : Math.max(0, originalTokens - injectedTokens);
        return {
          refId: x.refId ?? null,
          uri: x.uri ?? null,
          sha256: x.sha256 ?? null,
          path: x.path ? String(x.path) : '',
          toolName: String(x.toolName || 'tool'),
          decision: String(x.decision || 'DIRECT').toUpperCase(),
          criticalDomains: Array.isArray(x.criticalDomains) ? [...x.criticalDomains] : [],
          score: Number.isFinite(Number(x.score)) ? Number(x.score) : 0,
          originalTokens,
          injectedTokens,
          tokensSaved,
          step: Number.isFinite(Number(x.step)) ? Number(x.step) : 0,
          reason: String(x.reason || ''),
          at: x.at ?? 0,
        };
      },
    );

    mergeUnique(
      this.supervisorCalls,
      other.supervisorCalls,
      (x) =>
        `${x.stage ?? ''}|${x.model ?? ''}|${x.step ?? 0}|${x.candidateCount ?? 0}|${x.inputTokens ?? 0}|${x.outputTokens ?? 0}|${x.durationMs ?? 0}|${x.at ?? ''}`,
      (x) => {
        const inputTokens = Math.max(0, Number(x.inputTokens ?? 0));
        const outputTokens = Math.max(0, Number(x.outputTokens ?? 0));
        const totalTokens =
          x.totalTokens != null && Number.isFinite(Number(x.totalTokens))
            ? Math.max(0, Number(x.totalTokens))
            : inputTokens + outputTokens;
        return {
          stage: String(x.stage || 'admission'),
          model: x.model ? String(x.model) : null,
          candidateCount: Math.max(0, Number(x.candidateCount ?? 0)),
          decisions: x.decisions ? structuredClone(x.decisions) : null,
          inputTokens,
          outputTokens,
          totalTokens,
          durationMs: Math.max(0, Number(x.durationMs ?? 0)),
          ok: x.ok !== false,
          fallback: x.fallback ?? null,
          step: Number.isFinite(Number(x.step)) ? Number(x.step) : 0,
          at: x.at ?? 0,
        };
      },
    );

    mergeUnique(
      this.recoveries,
      other.recoveries,
      (x) =>
        `${x.refId ?? ''}|${x.uri ?? ''}|${x.sha256 ?? ''}|${normalizeContextPath(x.path)}|${x.level ?? ''}|${x.tokensRestored ?? 0}|${x.step ?? 0}|${x.at ?? ''}`,
      (x) => ({
        refId: x.refId ?? null,
        uri: x.uri ?? null,
        sha256: x.sha256 ?? null,
        path: x.path ? String(x.path) : '',
        level: String(x.level || 'verbatim'),
        verified: Boolean(x.verified),
        tokensRestored: Math.max(0, Number(x.tokensRestored ?? 0)),
        triggeredBy: String(x.triggeredBy || 'expand_context'),
        step: Number.isFinite(Number(x.step)) ? Number(x.step) : 0,
        at: x.at ?? 0,
      }),
    );

    if (!this.taskOutcome && other.taskOutcome && typeof other.taskOutcome === 'object') {
      this.taskOutcome = { ...other.taskOutcome };
    }
    return this;
  }

  /**
   * Formats a bounded cross-worker shared ACI summary digest (`<= maxChars`).
   */
  toSharedDigest({ maxChars = 1600, header = '[Shared Swarm ACI Digest]' } = {}) {
    return buildSharedAciSummary(this, { maxChars, header });
  }

  computeCriticalContextRecall(groundTruthFiles = []) {
    const truth = dedupePaths(groundTruthFiles);

    if (truth.length === 0) {
      return {
        recall: 1,
        activeRecall: 1,
        coverageRecall: 1,
        discoveryRecall: 1,
        total: 0,
        matched: [],
        missing: [],
        compressedOnly: [],
      };
    }

    const admittedActivePaths = this.admissions
      .filter((a) => a.decision === 'DIRECT' || a.decision === 'SUPPORTING')
      .map((a) => a.path)
      .filter(Boolean);
    const admittedStubPaths = this.admissions
      .filter((a) => a.decision === 'DEFER' || a.decision === 'IRRELEVANT' || a.decision === 'DUPLICATE')
      .map((a) => a.path)
      .filter(Boolean);
    const recoveredPaths = this.recoveries
      .filter((r) => r.verified !== false)
      .map((r) => r.path)
      .filter(Boolean);

    const activePaths = [
      ...this.kept.map((x) => x.path),
      ...this.expanded.map((x) => x.path),
      ...recoveredPaths,
      ...admittedActivePaths,
    ].filter(Boolean);
    const compressedPaths = [
      ...this.compressed.map((x) => x.path),
      ...admittedStubPaths,
    ].filter(Boolean);
    const discoveredPaths = [
      ...this.discovered.map((x) => x.path),
      ...activePaths,
      ...compressedPaths,
    ].filter(Boolean);

    const matched = [];
    const missing = [];
    const compressedOnly = [];
    let discoveredHits = 0;
    let coverageHits = 0;

    for (const gt of truth) {
      const inActive = activePaths.some((p) => pathsMatch(p, gt));
      const inCompressed = compressedPaths.some((p) => pathsMatch(p, gt));
      const inDiscovered = discoveredPaths.some((p) => pathsMatch(p, gt));
      if (inDiscovered) discoveredHits += 1;
      if (inActive || inCompressed) coverageHits += 1;
      if (inActive) {
        matched.push(gt);
      } else {
        missing.push(gt);
        if (inCompressed) compressedOnly.push(gt);
      }
    }

    const activeRecall = matched.length / truth.length;
    return {
      recall: activeRecall,
      activeRecall,
      coverageRecall: coverageHits / truth.length,
      discoveryRecall: discoveredHits / truth.length,
      total: truth.length,
      matched,
      missing,
      compressedOnly,
    };
  }

  computeGovernanceMetrics({
    groundTruthCriticalFiles = [],
    groundTruthRelevantFiles = [],
    groundTruthNoiseFiles = [],
  } = {}) {
    const decisionCounts = {
      DIRECT: 0,
      SUPPORTING: 0,
      DEFER: 0,
      DUPLICATE: 0,
      IRRELEVANT: 0,
    };
    let totalOriginalTokens = 0;
    let totalInjectedTokens = 0;
    let totalSavedTokens = 0;

    for (const a of this.admissions) {
      const dec = VALID_DECISION_TAGS.has(a.decision) ? a.decision : 'DIRECT';
      decisionCounts[dec] += 1;
      totalOriginalTokens += a.originalTokens || 0;
      totalInjectedTokens += a.injectedTokens || 0;
      totalSavedTokens += a.tokensSaved || 0;
    }

    const truthCritical = dedupePaths(groundTruthCriticalFiles);
    const truthRelevant = dedupePaths([
      ...truthCritical,
      ...(groundTruthRelevantFiles ?? []),
    ]);
    const truthNoise = dedupePaths(groundTruthNoiseFiles);

    // Critical recall & false-negative rate
    let criticalContextRecall = 1;
    let falseNegativeRate = 0;
    if (truthCritical.length > 0) {
      const compressedSet = this.compressed.map((c) => c.path).filter(Boolean);
      const restoredPaths = [
        ...this.expanded.map((e) => e.path),
        ...this.recoveries.filter((r) => r.verified !== false).map((r) => r.path),
      ].filter(Boolean);
      const activeAdmitted = this.admissions
        .filter((a) => a.decision === 'DIRECT' || a.decision === 'SUPPORTING')
        .map((a) => a.path)
        .filter(Boolean);
      const activeAll = [...activeAdmitted, ...this.kept.map((k) => k.path).filter(Boolean), ...restoredPaths];

      let criticalHits = 0;
      for (const gt of truthCritical) {
        const hasActive = activeAll.some((p) => pathsMatch(p, gt));
        const compressedWithoutRestore =
          compressedSet.some((p) => pathsMatch(p, gt)) &&
          !restoredPaths.some((p) => pathsMatch(p, gt));
        if (hasActive && !compressedWithoutRestore) {
          criticalHits += 1;
        }
      }
      criticalContextRecall = Number((criticalHits / truthCritical.length).toFixed(4));
      falseNegativeRate = Number((1 - criticalContextRecall).toFixed(4));
    }

    // Context precision & useful token ratio
    const nonIrrelevantFileAdmissions = this.admissions.filter(
      (a) =>
        (a.decision === 'DIRECT' || a.decision === 'SUPPORTING') &&
        a.path &&
        !/^(?:bash|glob|grep):/i.test(a.path),
    );

    let contextPrecision = 1;
    if (nonIrrelevantFileAdmissions.length > 0) {
      if (truthRelevant.length > 0) {
        const relevantHits = nonIrrelevantFileAdmissions.filter((a) =>
          truthRelevant.some((rp) => pathsMatch(a.path, rp)),
        ).length;
        contextPrecision = Number((relevantHits / nonIrrelevantFileAdmissions.length).toFixed(4));
      } else if (truthNoise.length > 0) {
        const nonNoiseHits = nonIrrelevantFileAdmissions.filter(
          (a) => !truthNoise.some((np) => pathsMatch(a.path, np)),
        ).length;
        contextPrecision = Number((nonNoiseHits / nonIrrelevantFileAdmissions.length).toFixed(4));
      }
    }

    const totalRecoveriesTokens = this.recoveries.reduce(
      (sum, r) => sum + (Number(r.tokensRestored) || 0),
      0,
    );
    const totalContextInjected = totalInjectedTokens + totalRecoveriesTokens;

    let usefulTokens = totalContextInjected;
    if (totalContextInjected > 0) {
      if (truthRelevant.length > 0) {
        usefulTokens =
          this.admissions
            .filter((a) => a.path && truthRelevant.some((rp) => pathsMatch(a.path, rp)))
            .reduce((sum, a) => sum + (a.injectedTokens || 0), 0) +
          this.recoveries
            .filter((r) => r.path && truthRelevant.some((rp) => pathsMatch(r.path, rp)))
            .reduce((sum, r) => sum + (r.tokensRestored || 0), 0);
      } else if (truthNoise.length > 0) {
        usefulTokens =
          this.admissions
            .filter((a) => !a.path || !truthNoise.some((np) => pathsMatch(a.path, np)))
            .reduce((sum, a) => sum + (a.injectedTokens || 0), 0) +
          this.recoveries
            .filter((r) => !r.path || !truthNoise.some((np) => pathsMatch(r.path, np)))
            .reduce((sum, r) => sum + (r.tokensRestored || 0), 0);
      } else {
        usefulTokens =
          this.admissions
            .filter((a) => a.decision === 'DIRECT' || a.decision === 'SUPPORTING')
            .reduce((sum, a) => sum + (a.injectedTokens || 0), 0) + totalRecoveriesTokens;
      }
    }
    const usefulTokenRatio =
      totalContextInjected > 0
        ? Number(Math.min(1, usefulTokens / totalContextInjected).toFixed(4))
        : 1;

    const admissionTokenReduction =
      totalOriginalTokens > 0
        ? Number(Math.max(0, totalSavedTokens / totalOriginalTokens).toFixed(4))
        : 0;

    const supervisorCost = {
      calls: this.supervisorCalls.length,
      inputTokens: this.supervisorCalls.reduce((s, c) => s + (c.inputTokens || 0), 0),
      outputTokens: this.supervisorCalls.reduce((s, c) => s + (c.outputTokens || 0), 0),
      totalTokens: this.supervisorCalls.reduce((s, c) => s + (c.totalTokens || 0), 0),
      durationMs: this.supervisorCalls.reduce((s, c) => s + (c.durationMs || 0), 0),
      fallbackCount: this.supervisorCalls.filter((c) => Boolean(c.fallback)).length,
    };

    const recoveryStats = {
      totalRecoveries: this.recoveries.length,
      hashVerifiedCount: this.recoveries.filter((r) => r.verified).length,
      tokensRestored: totalRecoveriesTokens,
    };

    return {
      criticalContextRecall,
      falseNegativeRate,
      contextPrecision,
      usefulTokenRatio,
      admissionTokenReduction,
      decisionCounts,
      supervisorCost,
      recoveryStats,
    };
  }

  summary() {
    const totalTokensSaved = this.compressed.reduce((sum, item) => sum + (item.tokensSaved || 0), 0);
    const admissionTokensSaved = this.admissions.reduce(
      (sum, item) => sum + (item.tokensSaved || 0),
      0,
    );
    return {
      discoveredCount: this.discovered.length,
      keptCount: this.kept.length,
      compressedCount: this.compressed.length,
      expandedCount: this.expanded.length,
      abstainedCount: this.abstained.length,
      totalTokensSaved,
      admissionsCount: this.admissions.length,
      admissionTokensSaved,
      supervisorCallsCount: this.supervisorCalls.length,
      recoveriesCount: this.recoveries.length,
    };
  }

  toJSON() {
    return {
      discovered: [...this.discovered],
      kept: [...this.kept],
      compressed: [...this.compressed],
      expanded: [...this.expanded],
      abstained: [...this.abstained],
      admissions: [...this.admissions],
      supervisorCalls: [...this.supervisorCalls],
      recoveries: [...this.recoveries],
      taskOutcome: this.taskOutcome ? { ...this.taskOutcome } : null,
      summary: this.summary(),
    };
  }
}

function cleanDigestToken(value, limit = 120) {
  return String(value ?? '')
    .replace(/[\r\n\t|]+/g, ' ')
    .replace(/<\/?untrusted[^>]*>/gi, '')
    .trim()
    .slice(0, limit);
}

/**
 * Builds a bounded cross-worker `[Shared Swarm ACI Digest]` string (`<= maxChars`)
 * from one or more `ContextEvidenceLedger` instances, `aciMetrics` objects, or child turn records.
 */
export function buildSharedAciSummary(aciMetricsOrLedger, opts = {}) {
  const rawMaxChars = opts?.maxChars ?? 1600;
  const maxChars = Number.isFinite(Number(rawMaxChars))
    ? Math.max(0, Math.trunc(Number(rawMaxChars)))
    : 1600;
  if (maxChars === 0) return '';

  const header = cleanDigestToken(opts?.header || '[Shared Swarm ACI Digest]', 80) || '[Shared Swarm ACI Digest]';
  const inputs = Array.isArray(aciMetricsOrLedger) ? aciMetricsOrLedger : [aciMetricsOrLedger];

  const criticalMap = new Map(); // normPath -> { path, domains: Set }
  const irrelevantMap = new Map(); // normPath -> path
  const deferredMap = new Map(); // key -> label
  const symbolSet = new Set();

  for (const sym of opts?.activeSymbols ?? []) {
    const clean = cleanDigestToken(sym, 64);
    if (clean) symbolSet.add(clean);
  }

  for (const src of inputs) {
    if (!src || typeof src !== 'object') continue;
    const rm = src.reasoningMetrics ?? src;
    const aci = rm.aciMetrics ?? src;
    const ledger = aci.ledger ?? src.ledger ?? aci;

    for (const sym of aci.activeSymbols ?? src.activeSymbols ?? []) {
      const clean = cleanDigestToken(sym, 64);
      if (clean) symbolSet.add(clean);
    }

    const admissions = Array.isArray(ledger?.admissions)
      ? ledger.admissions
      : Array.isArray(src.admissions)
        ? src.admissions
        : [];
    for (const adm of admissions) {
      if (!adm || typeof adm !== 'object') continue;
      const rawPath = cleanDigestToken(adm.path, 140);
      const norm = normalizeContextPath(rawPath);
      const decision = String(adm.decision || '').toUpperCase();
      if (decision === 'IRRELEVANT') {
        if (norm && !criticalMap.has(norm) && !irrelevantMap.has(norm)) {
          irrelevantMap.set(norm, rawPath || norm);
        }
      } else if (decision === 'DIRECT' || decision === 'SUPPORTING') {
        if (norm) {
          let entry = criticalMap.get(norm);
          if (!entry) {
            entry = { path: rawPath || norm, domains: new Set() };
            criticalMap.set(norm, entry);
          }
          for (const d of adm.criticalDomains ?? []) {
            const cleanD = cleanDigestToken(d, 32);
            if (cleanD) entry.domains.add(cleanD);
          }
          irrelevantMap.delete(norm);
        }
      } else if (decision === 'DEFER') {
        const uri = cleanDigestToken(adm.uri || adm.refId, 96);
        if (uri) {
          const key = `${uri}|${norm || rawPath}`;
          if (!deferredMap.has(key)) {
            deferredMap.set(key, rawPath ? `${uri} (${rawPath})` : uri);
          }
        }
      }
      if (decision === 'SUPPORTING' && adm.uri) {
        const uri = cleanDigestToken(adm.uri, 96);
        const key = `${uri}|${norm || rawPath}`;
        if (uri && !deferredMap.has(key)) {
          deferredMap.set(key, rawPath ? `${uri} (${rawPath})` : uri);
        }
      }
    }

    for (const k of ledger?.kept ?? []) {
      const rawPath = cleanDigestToken(k?.path, 140);
      const norm = normalizeContextPath(rawPath);
      if (norm && !criticalMap.has(norm)) {
        criticalMap.set(norm, { path: rawPath || norm, domains: new Set() });
      }
      irrelevantMap.delete(norm);
    }

    for (const r of ledger?.recoveries ?? []) {
      if (r?.verified === false) continue;
      const rawPath = cleanDigestToken(r?.path, 140);
      const norm = normalizeContextPath(rawPath);
      if (norm && !criticalMap.has(norm)) {
        criticalMap.set(norm, { path: rawPath || norm, domains: new Set() });
      }
      irrelevantMap.delete(norm);
    }

    for (const d of ledger?.discovered ?? []) {
      for (const sym of d?.symbols ?? []) {
        const clean = cleanDigestToken(sym, 64);
        if (clean) symbolSet.add(clean);
        if (symbolSet.size >= 24) break;
      }
    }

    for (const c of ledger?.compressed ?? []) {
      const uri = cleanDigestToken(c?.uri || c?.refId, 96);
      const rawPath = cleanDigestToken(c?.path, 140);
      const norm = normalizeContextPath(rawPath);
      if (uri) {
        const key = `${uri}|${norm || rawPath}`;
        if (!deferredMap.has(key)) {
          const range = cleanDigestToken(c?.lineRange, 24);
          const suffix = [rawPath, range].filter(Boolean).join(' ');
          deferredMap.set(key, suffix ? `${uri} (${suffix})` : uri);
        }
      }
    }
  }

  const criticalItems = [...criticalMap.values()].map((entry) => {
    const doms = [...entry.domains];
    return doms.length ? `${entry.path} [${doms.join(',')}]` : entry.path;
  });
  const symbolItems = [...symbolSet].slice(0, 16);
  const decoyItems = [...irrelevantMap.values()];
  const deferredItems = [...deferredMap.values()];

  if (
    criticalItems.length === 0 &&
    symbolItems.length === 0 &&
    decoyItems.length === 0 &&
    deferredItems.length === 0
  ) {
    return '';
  }

  const renderLines = (capPerSection) => {
    const lines = [header];
    if (criticalItems.length) {
      lines.push(`- Critical/Active Files: ${criticalItems.slice(0, capPerSection).join(', ')}`);
    }
    if (symbolItems.length) {
      lines.push(`- Active Symbols: ${symbolItems.slice(0, capPerSection).join(', ')}`);
    }
    if (decoyItems.length) {
      lines.push(`- IRRELEVANT Decoys (skip): ${decoyItems.slice(0, capPerSection).join(', ')}`);
    }
    if (deferredItems.length) {
      lines.push(`- Deferred Refs: ${deferredItems.slice(0, capPerSection).join(', ')}`);
    }
    return lines.join('\n');
  };

  for (const cap of [12, 8, 5, 3, 2, 1]) {
    const candidate = renderLines(cap);
    if (candidate.length <= maxChars) return candidate;
  }

  const minimal = renderLines(1);
  if (minimal.length <= maxChars) return minimal;
  if (maxChars <= 3) return minimal.slice(0, maxChars);
  return `${minimal.slice(0, maxChars - 3).trimEnd()}...`.slice(0, maxChars);
}
