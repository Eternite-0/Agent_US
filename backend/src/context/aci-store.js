import { createHash } from 'node:crypto';
import { estimateTokens } from '../context.js';
import { Fault } from '../store.js';

function sha256Hex(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex');
}

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
      .slice(0, 12);
  }
  if (typeof symbolOutline === 'string' && symbolOutline.trim()) {
    return symbolOutline
      .split(/[,;\n]/)
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 12);
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

/**
 * Formats the compact reversible ACI reference stub for an aged tool output.
 */
export function formatAciRefStub(ref) {
  const pathPart = String(ref.path || ref.toolName || 'output').replace(/[|\r\n]+/g, ' ').trim();
  const linesPart = String(ref.lineRange || 'L1-EOF').replace(/[|\r\n]+/g, ' ').trim();
  const symbolsList = normalizeSymbolOutline(ref.symbolOutline);
  const symbolsPart = symbolsList.length
    ? symbolsList.slice(0, 6).join(',').slice(0, 80)
    : '-';
  const tok = Math.max(1, Number(ref.originalTokens || 0));
  return `[ACI-REF ${ref.uri} | ${pathPart} | ${linesPart} | ${symbolsPart} | ~${tok} tok | call expand_context or read_blob to restore]`;
}

/**
 * ReversibleContextStore wraps `store.putBlob`/`store.getBlob` (`artifact://...`)
 * with structured metadata refs and 100% lossless restoration.
 */
export class ReversibleContextStore {
  #memoryBlobs = new Map();
  #refsById = new Map();
  #refsByUri = new Map();
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
      const row = this.store.getBlob(clean.startsWith('artifact://') ? clean : `artifact://${key}`);
      if (row && typeof row.content === 'string') return row.content;
    }
    if (this.#memoryBlobs.has(key)) {
      return this.#memoryBlobs.get(key);
    }
    throw new Fault('ARTIFACT_NOT_FOUND', 404, { message: `Artifact not found: ${sha256OrUri}` });
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
      restoredCount: 0,
      bytes: saved.bytes,
      chars: raw.length,
      createdAt: Date.now(),
    };
    const stubText = formatAciRefStub(ref);
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
      return list?.length ? { ...list[list.length - 1] } : null;
    }
    return null;
  }

  listRefs() {
    return [...this.#refsById.values()].map((r) => ({ ...r }));
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
}

/**
 * ContextEvidenceLedger records discovered candidates, kept/compressed/expanded
 * items, abstentions, and computes Critical Context Recall against ground truth.
 */
export class ContextEvidenceLedger {
  constructor() {
    this.discovered = [];
    this.kept = [];
    this.compressed = [];
    this.expanded = [];
    this.abstained = [];
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

  computeCriticalContextRecall(groundTruthFiles = []) {
    const truth = [];
    const seenTruth = new Set();
    for (const file of groundTruthFiles ?? []) {
      const clean = String(file ?? '').trim();
      const norm = normalizeContextPath(clean);
      if (!norm || seenTruth.has(norm)) continue;
      seenTruth.add(norm);
      truth.push(clean);
    }

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

    const activePaths = [
      ...this.kept.map((x) => x.path),
      ...this.expanded.map((x) => x.path),
    ].filter(Boolean);
    const compressedPaths = this.compressed.map((x) => x.path).filter(Boolean);
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

  summary() {
    const totalTokensSaved = this.compressed.reduce((sum, item) => sum + (item.tokensSaved || 0), 0);
    return {
      discoveredCount: this.discovered.length,
      keptCount: this.kept.length,
      compressedCount: this.compressed.length,
      expandedCount: this.expanded.length,
      abstainedCount: this.abstained.length,
      totalTokensSaved,
    };
  }
}
