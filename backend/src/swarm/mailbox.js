import { id as uuid } from '../store.js';
import { RUNTIME_EVENTS } from '../kernel/events.js';
import { assertLeaseInTx } from '../durable/lease-guard.js';
import { CommunicationBus } from '../communication/bus.js';
import { StoreCommunicationAdapter } from '../communication/store-adapter.js';
import * as aciStoreMod from '../context/aci-store.js';

function parseJsonSafe(str, fallback) {
  if (!str) return fallback;
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

function normPath(raw) {
  if (!raw) return '';
  if (typeof aciStoreMod.normalizeContextPath === 'function') {
    return aciStoreMod.normalizeContextPath(raw);
  }
  return String(raw).trim().replace(/\\/g, '/').replace(/^\.\/+/, '');
}

function pushUnique(arr, seen, value) {
  const s = String(value ?? '').trim();
  if (!s || seen.has(s)) return;
  seen.add(s);
  arr.push(s);
}

/**
 * Extracts compact shareable ACI discoveries from any turn's `aciMetrics`,
 * `ContextEvidenceLedger`, or pre-compacted sharing summary.
 */
export function extractAciSharingFacts(input) {
  const empty = {
    admittedCriticalFiles: [],
    activeSymbols: [],
    irrelevantDecoyPaths: [],
    deferredRefs: [],
  };
  if (!input || typeof input !== 'object') return empty;

  const src = input.aciMetrics && typeof input.aciMetrics === 'object' ? input.aciMetrics : input;
  const ledger = src.ledger && typeof src.ledger === 'object' ? src.ledger : src;

  const critical = [];
  const criticalSeen = new Set();
  const symbols = [];
  const symbolSeen = new Set();
  const irrelevant = [];
  const irrelevantSeen = new Set();
  const deferred = [];
  const deferredSeen = new Set();

  const addCritical = (p) => {
    const np = normPath(p);
    if (np && !/^(?:bash|glob|grep):/i.test(np)) pushUnique(critical, criticalSeen, np);
  };
  const addSymbol = (sym) => {
    if (typeof sym === 'string') {
      pushUnique(symbols, symbolSeen, sym);
    } else if (sym && typeof sym === 'object') {
      const name = String(sym.symbol ?? sym.name ?? '').trim();
      const p = normPath(sym.path ?? '');
      if (name) pushUnique(symbols, symbolSeen, p ? `${p}:${name}` : name);
      else if (Array.isArray(sym.symbols)) {
        for (const s of sym.symbols) {
          const sn = String(s ?? '').trim();
          if (sn) pushUnique(symbols, symbolSeen, p ? `${p}:${sn}` : sn);
        }
      }
    }
  };
  const addIrrelevant = (p) => {
    const np = normPath(p);
    if (np && !/^(?:bash|glob|grep):/i.test(np)) pushUnique(irrelevant, irrelevantSeen, np);
  };
  const addDeferred = (ref) => {
    if (!ref) return;
    if (typeof ref === 'string') {
      const s = ref.trim();
      if (!s || deferredSeen.has(s)) return;
      deferredSeen.add(s);
      deferred.push({ uri: s, path: '' });
      return;
    }
    if (typeof ref === 'object') {
      const uri = String(ref.uri ?? ref.refId ?? '').trim();
      const path = normPath(ref.path ?? '');
      const key = uri || path;
      if (!key || deferredSeen.has(key)) return;
      deferredSeen.add(key);
      deferred.push({ uri: uri || null, path: path || null });
    }
  };

  for (const p of src.admittedCriticalFiles ?? src.criticalFiles ?? []) addCritical(p);
  for (const sym of src.activeSymbols ?? src.symbols ?? []) addSymbol(sym);
  for (const p of src.irrelevantDecoyPaths ?? src.irrelevantPaths ?? src.decoyPaths ?? []) addIrrelevant(p);
  for (const ref of src.deferredRefs ?? src.deferred ?? []) addDeferred(ref);

  const admissions = Array.isArray(ledger?.admissions)
    ? ledger.admissions
    : Array.isArray(src.admissions)
      ? src.admissions
      : [];
  for (const a of admissions) {
    if (!a || typeof a !== 'object') continue;
    const dec = String(a.decision ?? '').toUpperCase();
    if (dec === 'DIRECT' || dec === 'SUPPORTING') {
      addCritical(a.path);
      for (const s of a.symbols ?? a.symbolOutline ?? []) {
        addSymbol(typeof s === 'string' && a.path ? { path: a.path, symbol: s } : s);
      }
    } else if (dec === 'IRRELEVANT') {
      addIrrelevant(a.path);
    } else if (dec === 'DEFER') {
      addDeferred({ uri: a.uri ?? a.refId, path: a.path });
    }
  }

  for (const k of ledger?.kept ?? []) {
    if (k?.path) addCritical(k.path);
  }
  for (const e of ledger?.expanded ?? []) {
    if (e?.path) addCritical(e.path);
  }
  for (const r of ledger?.recoveries ?? []) {
    if (r?.verified !== false && r?.path) addCritical(r.path);
  }
  for (const c of ledger?.compressed ?? []) {
    addDeferred({ uri: c?.uri ?? c?.refId, path: c?.path });
  }
  for (const d of ledger?.discovered ?? []) {
    if (!d || typeof d !== 'object') continue;
    const dp = normPath(d.path);
    if (dp && irrelevantSeen.has(dp)) continue;
    for (const s of d.symbols ?? []) {
      addSymbol(typeof s === 'string' && dp ? { path: dp, symbol: s } : s);
    }
  }

  // Never keep a file in irrelevant decoys if it was also admitted/recovered as critical
  const filteredIrrelevant = irrelevant.filter((p) => !criticalSeen.has(p));

  return {
    admittedCriticalFiles: critical,
    activeSymbols: symbols,
    irrelevantDecoyPaths: filteredIrrelevant,
    deferredRefs: deferred,
  };
}

export function compactAciMetricsForSharing(aciMetrics) {
  const facts = extractAciSharingFacts(aciMetrics);
  const total =
    facts.admittedCriticalFiles.length +
    facts.activeSymbols.length +
    facts.irrelevantDecoyPaths.length +
    facts.deferredRefs.length;
  if (total === 0) return null;
  return {
    admittedCriticalFiles: facts.admittedCriticalFiles.slice(0, 32),
    activeSymbols: facts.activeSymbols.slice(0, 32),
    irrelevantDecoyPaths: facts.irrelevantDecoyPaths.slice(0, 32),
    deferredRefs: facts.deferredRefs.slice(0, 24),
  };
}

function clampBoundedText(text, maxChars) {
  const cap = Math.max(32, Math.floor(Number(maxChars || 1600)));
  const str = String(text ?? '');
  if (str.length <= cap) return str;
  if (cap <= 4) return str.slice(0, cap);
  return `${str.slice(0, cap - 3)}...`;
}

/**
 * Aggregates completed upstream workers' ACI discoveries (admitted critical files,
 * active symbols, IRRELEVANT decoy paths, deferred refs) into a bounded
 * `[Shared Swarm ACI Digest]` (`<= 1600` chars) for downstream handoffs and prompts.
 * Uses `aciStoreMod.buildSharedAciSummary` if exported when merged, falling back cleanly
 * to the self-contained Swarm aggregator/formatter.
 */
export function buildSharedAciDigest(upstreamInputs, { maxChars = 1600 } = {}) {
  const cap = Math.max(64, Math.min(1600, Math.floor(Number(maxChars || 1600))));
  const list = Array.isArray(upstreamInputs) ? upstreamInputs : upstreamInputs ? [upstreamInputs] : [];

  const critical = [];
  const criticalSeen = new Set();
  const symbols = [];
  const symbolSeen = new Set();
  const irrelevant = [];
  const irrelevantSeen = new Set();
  const deferred = [];
  const deferredSeen = new Set();
  const workerKeys = [];
  const workerSeen = new Set();

  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const nodeKey = item.nodeKey ? String(item.nodeKey).trim() : '';
    const metrics = item.aciMetrics && typeof item.aciMetrics === 'object' ? item.aciMetrics : item;
    const facts = extractAciSharingFacts(metrics);
    const hasFacts =
      facts.admittedCriticalFiles.length > 0 ||
      facts.activeSymbols.length > 0 ||
      facts.irrelevantDecoyPaths.length > 0 ||
      facts.deferredRefs.length > 0;
    if (!hasFacts) continue;
    if (nodeKey && !workerSeen.has(nodeKey)) {
      workerSeen.add(nodeKey);
      workerKeys.push(nodeKey);
    }
    for (const f of facts.admittedCriticalFiles) pushUnique(critical, criticalSeen, f);
    for (const s of facts.activeSymbols) pushUnique(symbols, symbolSeen, s);
    for (const d of facts.irrelevantDecoyPaths) pushUnique(irrelevant, irrelevantSeen, d);
    for (const r of facts.deferredRefs) {
      const k = r.uri || r.path;
      if (k && !deferredSeen.has(k)) {
        deferredSeen.add(k);
        deferred.push(r);
      }
    }
  }

  const finalIrrelevant = irrelevant.filter((p) => !criticalSeen.has(p));
  const hasAny =
    critical.length > 0 ||
    symbols.length > 0 ||
    finalIrrelevant.length > 0 ||
    deferred.length > 0;

  // Optional integration with rt-aci-25's buildSharedAciSummary when merged on single/ledger input
  if (typeof aciStoreMod?.buildSharedAciSummary === 'function' && list.length === 1 && !hasAny) {
    try {
      const rawExt = String(aciStoreMod.buildSharedAciSummary(list[0], { maxChars: cap }) ?? '').trim();
      if (rawExt) {
        const prefixed = rawExt.startsWith('[Shared Swarm ACI Digest]')
          ? rawExt
          : `[Shared Swarm ACI Digest]\n${rawExt}`;
        return clampBoundedText(prefixed, cap);
      }
    } catch {
      // fall through cleanly to self-contained formatter
    }
  }

  if (!hasAny) return '';

  const header = workerKeys.length
    ? `[Shared Swarm ACI Digest] (upstream: ${workerKeys.slice(0, 6).join(', ')})`
    : '[Shared Swarm ACI Digest]';
  const formatSectionLine = (label, items, itemFormatter = (x) => x, maxLineChars = Infinity) => {
    if (!items.length) return null;
    const prefix = `${label}: `;
    if (maxLineChars <= prefix.length + 8) return null;
    const parts = [];
    let curLen = prefix.length;
    for (let i = 0; i < items.length; i += 1) {
      const token = String(itemFormatter(items[i]) ?? '').trim();
      if (!token) continue;
      const addLen = (parts.length > 0 ? 2 : 0) + token.length;
      const moreCount = items.length - i;
      const suffixReserve = moreCount > 1 ? 14 : 0;
      if (Number.isFinite(maxLineChars) && curLen + addLen + suffixReserve > maxLineChars && parts.length > 0) {
        return clampBoundedText(`${prefix}${parts.join(', ')} (+${moreCount} more)`, maxLineChars);
      }
      parts.push(token);
      curLen += addLen;
    }
    return clampBoundedText(`${prefix}${parts.join(', ')}`, maxLineChars);
  };

  const sectionSpecs = [
    { label: 'Admitted critical files', items: critical, fmt: (x) => x },
    { label: 'Active symbols', items: symbols, fmt: (x) => x },
    { label: 'IRRELEVANT decoys (avoid re-reading)', items: finalIrrelevant, fmt: (x) => x },
    {
      label: 'Deferred refs',
      items: deferred,
      fmt: (r) => (r.path && r.uri ? `${r.path} (${r.uri})` : (r.uri || r.path)),
    },
  ].filter((s) => s.items.length > 0);

  const rawFullLines = sectionSpecs.map((s) => formatSectionLine(s.label, s.items, s.fmt));
  const availForSections = Math.max(64, cap - header.length - sectionSpecs.length);
  const perEqual = Math.max(48, Math.floor(availForSections / Math.max(1, sectionSpecs.length)));

  let usedShort = 0;
  let overflowCount = 0;
  for (const full of rawFullLines) {
    if (full && full.length <= perEqual) {
      usedShort += full.length;
    } else if (full) {
      overflowCount += 1;
    }
  }
  const overflowCap =
    overflowCount > 0
      ? Math.max(48, Math.floor((availForSections - usedShort) / overflowCount))
      : availForSections;

  const lines = [header];
  for (let i = 0; i < sectionSpecs.length; i += 1) {
    const full = rawFullLines[i];
    if (!full) continue;
    const curLen = lines.join('\n').length;
    const remaining = cap - curLen - 1;
    if (remaining <= 16) break;
    const secCap = Math.min(remaining, full.length <= perEqual ? full.length : overflowCap);
    const formatted = formatSectionLine(sectionSpecs[i].label, sectionSpecs[i].items, sectionSpecs[i].fmt, secCap);
    if (formatted) lines.push(formatted);
  }

  return clampBoundedText(lines.join('\n'), cap);
}

/**
 * Layer 6 InterAgentMailbox persisted in SQLite `agent_messages`.
 * Enables structured asynchronous peer & parent-child handoffs inside a Swarm run.
 */
export class InterAgentMailbox {
  constructor({ store, eventRouter = null, communication = null }) {
    this.store = store;
    this.eventRouter = eventRouter;
    this.bus = communication ?? new CommunicationBus({ adapter: new StoreCommunicationAdapter({ store }) });
  }

  #dbOpen() {
    return Boolean(this.store?.db?.isOpen);
  }

  setCommunicationBus(bus) {
    if (!bus || typeof bus.send !== 'function' || typeof bus.receive !== 'function') throw new TypeError('CommunicationBus is required');
    this.bus = bus;
    return this.bus;
  }

  send({
    runId = null,
    sessionId = null,
    fromAgentId,
    toAgentId,
    kind = 'note',
    payload,
    conversationId = null,
    idempotencyKey = null,
    artifactManifest = undefined,
    aciMetrics = undefined,
    maxAttempts = undefined,
    createdAt = undefined,
    expiresAt = undefined,
  }) {
    const rawBody = typeof payload === 'string' ? { text: payload } : payload ? { ...payload } : {};
    const effectiveAci = aciMetrics ?? rawBody.aciMetrics ?? null;
    if (effectiveAci && !rawBody.sharedAciDigest) {
      const digest = buildSharedAciDigest([{ nodeKey: fromAgentId, aciMetrics: effectiveAci }], {
        maxChars: 1600,
      });
      if (digest) rawBody.sharedAciDigest = digest;
      const compact = compactAciMetricsForSharing(effectiveAci);
      if (compact) rawBody.aciMetrics = compact;
    }
    if (typeof rawBody.sharedAciDigest === 'string' && rawBody.sharedAciDigest.length > 1600) {
      rawBody.sharedAciDigest = clampBoundedText(rawBody.sharedAciDigest, 1600);
    }
    if (conversationId) {
      // Unified messages intentionally remain out of the legacy agent_messages table.
      // Preserve the synchronous return shape for legacy callers while returning the
      // CommunicationBus promise for the durable envelope path.
      return this.bus.send({
        conversationId: String(conversationId),
        runId,
        fromAgentId: String(fromAgentId),
        toAgentId: String(toAgentId),
        kind,
        idempotencyKey: idempotencyKey ?? uuid(),
        payload: rawBody,
        artifactManifest,
        ...(maxAttempts !== undefined ? { maxAttempts } : {}),
        ...(createdAt !== undefined ? { createdAt } : {}),
        ...(expiresAt !== undefined ? { expiresAt } : {}),
      });
    }
    const msgId = uuid();
    const now = Date.now();
    const body = rawBody;
    this.store.tx(() => {
      this.store.db
        .prepare(
          `INSERT INTO agent_messages(
            id, runId, fromAgentId, toAgentId, kind, payloadJson, status, createdAt
          ) VALUES(?,?,?,?,?,?,'queued',?)`,
        )
        .run(msgId, runId, String(fromAgentId), String(toAgentId), String(kind), JSON.stringify(body), now);
    });

    if (sessionId && this.eventRouter) {
      try {
        this.eventRouter.emitPersisted({
          sessionId,
          turnId: null,
          type: RUNTIME_EVENTS.SWARM_MESSAGE,
          data: { id: msgId, runId, fromAgentId, toAgentId, kind, payload: body },
          audit: false,
        });
      } catch {
        // best-effort event emission after committed send
      }
    }

    return {
      id: msgId,
      runId,
      fromAgentId,
      toAgentId,
      kind,
      payload: body,
      status: 'queued',
      createdAt: now,
    };
  }

  /**
   * Claim one durable CommunicationBus message. This is the unified counterpart to
   * legacy drainInbox(); it returns a deliveryToken that must be supplied to ack/retry.
   */
  receive(toAgentId, options = {}) {
    return this.bus.receive(String(toAgentId), options);
  }

  claim(toAgentId, options = {}) {
    return this.receive(toAgentId, options);
  }

  ack(messageId, agentId, deliveryToken = undefined) {
    return this.bus.ack(String(messageId), String(agentId), deliveryToken);
  }

  bindClaimToChildInTx(input = {}) {
    if (!this.bus?.bindClaimToChildInTx) throw new TypeError('CommunicationBus child binding is required');
    return this.bus.bindClaimToChildInTx(input);
  }


  retry(messageId, agentId, options = {}) {
    return this.bus.retry(String(messageId), String(agentId), options);
  }

  sweep() {
    return this.bus.sweep();
  }

  getMessage(messageId) {
    return this.bus.get(String(messageId));
  }

  /**
   * Non-destructively peeks queued inbox messages so callers can acknowledge delivery
   * atomically inside the turn-start transaction (preventing lost messages on crash/lease loss).
   */
  peekInbox(toAgentId, { runId = null, limit = 20 } = {}) {
    if (!this.#dbOpen()) return [];
    const cap = Math.min(100, Math.max(1, Number(limit || 20)));
    const rows = runId
      ? this.store.db
          .prepare(
            `SELECT * FROM agent_messages
             WHERE toAgentId=? AND runId=? AND status='queued'
             ORDER BY createdAt ASC, rowid ASC LIMIT ?`,
          )
          .all(String(toAgentId), runId, cap)
      : this.store.db
          .prepare(
            `SELECT * FROM agent_messages
             WHERE toAgentId=? AND status='queued'
             ORDER BY createdAt ASC, rowid ASC LIMIT ?`,
          )
          .all(String(toAgentId), cap);
    return rows.map((r) => ({
      id: r.id,
      runId: r.runId,
      fromAgentId: r.fromAgentId,
      toAgentId: r.toAgentId,
      kind: r.kind,
      payload: parseJsonSafe(r.payloadJson, {}),
      status: r.status,
      createdAt: r.createdAt,
      deliveredAt: r.deliveredAt ?? null,
    }));
  }

  /**
   * Atomically acknowledges queued messages as delivered, guarded by optional leaseGuard.
   */
  ackMessages(ids = [], { leaseGuard = null, runId = null, nodeId = null } = {}) {
    if (!this.#dbOpen() || !Array.isArray(ids) || !ids.length) return 0;
    const now = Date.now();
    return this.store.tx(() => {
      assertLeaseInTx(leaseGuard, { runId, nodeId });
      const upd = this.store.db.prepare(
        "UPDATE agent_messages SET status='delivered', deliveredAt=? WHERE id=? AND status='queued'",
      );
      let count = 0;
      for (const id of ids) {
        if (!id) continue;
        const res = upd.run(now, String(id));
        if (res.changes > 0) count++;
      }
      return count;
    });
  }

  /**
   * Atomically selects and marks queued messages as delivered inside ONE SQLite transaction,
   * returning only rows exclusively claimed by this caller (`changes > 0`).
   */
  drainInbox(toAgentId, { runId = null, limit = 20, leaseGuard = null, nodeId = null } = {}) {
    if (!this.#dbOpen()) return [];
    const cap = Math.min(100, Math.max(1, Number(limit || 20)));
    const now = Date.now();
    return this.store.tx(() => {
      assertLeaseInTx(leaseGuard, { runId, nodeId });
      const rows = runId
        ? this.store.db
            .prepare(
              `SELECT * FROM agent_messages
               WHERE toAgentId=? AND runId=? AND status='queued'
               ORDER BY createdAt ASC, rowid ASC LIMIT ?`,
            )
            .all(String(toAgentId), runId, cap)
        : this.store.db
            .prepare(
              `SELECT * FROM agent_messages
               WHERE toAgentId=? AND status='queued'
               ORDER BY createdAt ASC, rowid ASC LIMIT ?`,
            )
            .all(String(toAgentId), cap);

      if (!rows.length) return [];
      const upd = this.store.db.prepare(
        "UPDATE agent_messages SET status='delivered', deliveredAt=? WHERE id=? AND status='queued'",
      );
      const delivered = [];
      for (const r of rows) {
        const res = upd.run(now, r.id);
        if (res.changes > 0) {
          delivered.push({
            id: r.id,
            runId: r.runId,
            fromAgentId: r.fromAgentId,
            toAgentId: r.toAgentId,
            kind: r.kind,
            payload: parseJsonSafe(r.payloadJson, {}),
            status: 'delivered',
            createdAt: r.createdAt,
            deliveredAt: now,
          });
        }
      }
      return delivered;
    });
  }

  buildSharedAciDigest(entries, opts = {}) {
    return buildSharedAciDigest(entries, opts);
  }

  listForRun(runId, { limit = 200 } = {}) {
    if (!this.#dbOpen()) return [];
    return this.store.db
      .prepare('SELECT * FROM agent_messages WHERE runId=? ORDER BY createdAt ASC, rowid ASC LIMIT ?')
      .all(runId, Math.min(500, Math.max(1, Number(limit || 200))))
      .map((r) => ({
        ...r,
        payload: parseJsonSafe(r.payloadJson, {}),
      }));
  }
}
