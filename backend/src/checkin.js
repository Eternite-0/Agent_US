import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Fault, id as uuid } from './store.js';

function todayDateStr(now = Date.now()) {
  const d = new Date(now);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function currentHHMM(now = Date.now()) {
  const d = new Date(now);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function parseJsonSafe(str, fallback) {
  if (!str) return fallback;
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

function stripV1(endpoint) {
  return String(endpoint || '')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/v1$/i, '');
}

function resolvePathValue(obj, dottedPath) {
  if (!obj || !dottedPath) return undefined;
  return String(dottedPath)
    .split('.')
    .reduce((acc, part) => (acc && typeof acc === 'object' ? acc[part] : undefined), obj);
}

export class CheckinService {
  constructor(store, pool, { root }) {
    this.store = store;
    this.pool = pool;
    this.root = root;
    this.pluginsDir = join(root, 'checkin-plugins');
    this.running = false;
    this.timer = null;
  }

  #shouldRunTimer() {
    if (this.#getActiveBridgeTarget()) return false;
    const autoEnabled = Boolean(
      this.store.getSetting('checkin.auto_enabled', false),
    );
    if (!autoEnabled) return false;
    const row = this.store.db
      .prepare('SELECT 1 FROM checkin_schedules WHERE enabled=1 LIMIT 1')
      .get();
    return Boolean(row);
  }

  #syncTimer() {
    if (!this.started) return;
    if (this.#shouldRunTimer()) {
      if (!this.timer) {
        this.timer = setInterval(() => {
          void this.#tickSchedules().catch(() => {});
        }, 60_000);
        this.timer.unref();
      }
    } else if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  start() {
    this.started = true;
    this.#syncTimer();
  }

  stop() {
    this.started = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // ---- Bridge Configuration (Mode A: User's running Agent2API server) ----

  getBridgeConfig() {
    const saved = this.store.getSetting('checkin.bridge', null);
    if (saved && saved.baseUrl) {
      return {
        mode: saved.mode ?? 'auto',
        baseUrl: stripV1(saved.baseUrl),
        hasApiKey: Boolean(saved.apiKeyEnc),
        hasPanelToken: Boolean(saved.panelTokenEnc),
        source: 'explicit',
      };
    }
    // Auto-discover from an enabled `agent2api` account in the pool
    const acc = this.pool
      .listAccounts({ preset: 'agent2api', enabled: true })
      .find((a) => a.endpoint);
    if (acc) {
      return {
        mode: 'auto',
        baseUrl: stripV1(acc.endpoint),
        hasApiKey: Boolean(acc.credential),
        hasPanelToken: false,
        source: 'pool-account',
        accountId: acc.id,
      };
    }
    return {
      mode: 'local',
      baseUrl: '',
      hasApiKey: false,
      hasPanelToken: false,
      source: 'none',
    };
  }

  setBridgeConfig({ mode = 'auto', baseUrl = '', apiKey, panelToken } = {}) {
    const prev = this.store.getSetting('checkin.bridge', {}) ?? {};
    const cleanUrl = baseUrl ? stripV1(baseUrl) : '';
    const next = {
      mode: ['auto', 'bridge', 'local'].includes(mode) ? mode : 'auto',
      baseUrl: cleanUrl,
      apiKeyEnc:
        apiKey !== undefined
          ? apiKey
            ? this.pool.encrypt(String(apiKey).trim())
            : null
          : prev.apiKeyEnc ?? null,
      panelTokenEnc:
        panelToken !== undefined
          ? panelToken
            ? this.pool.encrypt(String(panelToken).trim())
            : null
          : prev.panelTokenEnc ?? null,
    };
    this.store.setSetting('checkin.bridge', next);
    return this.getBridgeConfig();
  }

  #getActiveBridgeTarget() {
    const saved = this.store.getSetting('checkin.bridge', null);
    if (saved?.mode === 'local') return null;
    if (saved?.baseUrl) {
      return {
        baseUrl: stripV1(saved.baseUrl),
        apiKey: saved.apiKeyEnc ? this.pool.decrypt(saved.apiKeyEnc) : '',
        panelToken: saved.panelTokenEnc
          ? this.pool.decrypt(saved.panelTokenEnc)
          : '',
      };
    }
    const accRow = this.store.db
      .prepare(
        "SELECT * FROM provider_accounts WHERE preset='agent2api' AND enabled=1 ORDER BY priority ASC LIMIT 1",
      )
      .get();
    if (accRow?.endpoint) {
      return {
        baseUrl: stripV1(accRow.endpoint),
        apiKey: this.pool.decrypt(accRow.credentialEnc),
        panelToken: '',
      };
    }
    return null;
  }

  async #bridgeCall(path, { method = 'GET', body, timeoutMs = 10000 } = {}) {
    const target = this.#getActiveBridgeTarget();
    if (!target) return null;
    const headers = { Accept: 'application/json' };
    if (target.apiKey) {
      headers['x-api-key'] = target.apiKey;
      headers.Authorization = `Bearer ${target.apiKey}`;
    }
    if (target.panelToken) {
      headers['x-panel-token'] = target.panelToken;
      headers.Authorization = `Bearer ${target.panelToken}`;
    }
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${target.baseUrl}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Agent2API HTTP ${res.status}: ${text.slice(0, 180)}`);
    }
    return await res.json();
  }

  async testBridge() {
    const target = this.#getActiveBridgeTarget();
    if (!target) {
      return {
        ok: false,
        connected: false,
        error: '未配置 Agent2API 网关地址（可先在账号池添加 Agent2API 或在此填写地址）',
      };
    }
    const started = Date.now();
    try {
      const health = await fetch(`${target.baseUrl}/health`, {
        signal: AbortSignal.timeout(4000),
      });
      const center = await this.#bridgeCall('/api/checkin-center', {
        timeoutMs: 6000,
      });
      return {
        ok: true,
        connected: true,
        baseUrl: target.baseUrl,
        healthOk: health.ok,
        latencyMs: Date.now() - started,
        providersCount: center?.daily?.providers?.length ?? 0,
        todayDone: center?.daily?.todayDone ?? 0,
        todayEligible: center?.daily?.todayEligible ?? 0,
      };
    } catch (err) {
      return {
        ok: false,
        connected: false,
        baseUrl: target.baseUrl,
        latencyMs: Date.now() - started,
        error: String(err?.message ?? err),
      };
    }
  }

  // ---- Pluggable Local Checkin Adapters (Mode B) ----

  listLocalPlugins() {
    if (!existsSync(this.pluginsDir)) return [];
    const list = [];
    for (const file of readdirSync(this.pluginsDir)) {
      if (file.endsWith('.json')) {
        try {
          const def = JSON.parse(
            readFileSync(join(this.pluginsDir, file), 'utf8'),
          );
          if (def?.providerId && def?.url) {
            list.push({
              kind: 'webhook',
              file,
              providerId: String(def.providerId),
              label: String(def.label || def.providerId),
              description: String(def.description || '自定义 Webhook 签到适配器'),
              section: def.section || 'daily',
              def,
            });
          }
        } catch {
          // skip malformed plugin json
        }
      } else if (file.endsWith('.mjs')) {
        list.push({
          kind: 'script',
          file,
          providerId: file.replace(/\.mjs$/, ''),
          label: file.replace(/\.mjs$/, ''),
          description: '本地自定义 ESM 签到插件',
          section: 'daily',
          path: join(this.pluginsDir, file),
        });
      }
    }
    return list;
  }

  async #executeLocalCheckin(accountRow, { kind = 'manual', section = 'daily' } = {}) {
    const presetSpec = this.pool.getPreset(accountRow.preset);
    const plugins = this.listLocalPlugins();
    const plugin = plugins.find(
      (p) =>
        p.providerId === accountRow.preset || p.providerId === accountRow.id,
    );
    const now = Date.now();
    const date = todayDateStr(now);
    const meta = parseJsonSafe(accountRow.meta, {});
    const webhookCfg = meta.checkinWebhook || plugin?.def || null;

    let outcome = 'skipped';
    let message = '';
    let error = null;
    let points = 0;

    if (plugin?.kind === 'script') {
      try {
        const mod = await import(`${pathToFileURL(plugin.path).href}?t=${now}`);
        if (typeof mod.checkin !== 'function') {
          throw new Error('插件缺少 export async function checkin(account, ctx)');
        }
        const secret = this.pool.decrypt(accountRow.credentialEnc);
        const res = await mod.checkin(
          {
            id: accountRow.id,
            preset: accountRow.preset,
            label: accountRow.label,
            endpoint: accountRow.endpoint,
            credential: secret,
            headers: parseJsonSafe(accountRow.headers, {}),
            meta,
          },
          { section, kind },
        );
        outcome = res?.alreadyCompleted
          ? 'already_done'
          : res?.ok === false
            ? 'failed'
            : 'succeeded';
        message = String(res?.message || (outcome === 'succeeded' ? '插件签到成功' : '今日已签到'));
        error = res?.error ? String(res.error) : null;
        points = Number(res?.points ?? 0) || 0;
      } catch (err) {
        outcome = 'failed';
        error = String(err?.message ?? err);
      }
    } else if (webhookCfg?.url) {
      try {
        const secret = this.pool.decrypt(accountRow.credentialEnc);
        const rawHeaders = { ...(webhookCfg.headers ?? {}) };
        const headers = {};
        for (const [k, v] of Object.entries(rawHeaders)) {
          headers[k] = String(v).replace(/\{\{credential\}\}/g, secret);
        }
        if (secret && !headers.Authorization && webhookCfg.authBearer !== false) {
          headers.Authorization = `Bearer ${secret}`;
        }
        const res = await fetch(String(webhookCfg.url), {
          method: String(webhookCfg.method || 'POST').toUpperCase(),
          headers,
          body:
            webhookCfg.body !== undefined
              ? typeof webhookCfg.body === 'string'
                ? webhookCfg.body
                : JSON.stringify(webhookCfg.body)
              : undefined,
          signal: AbortSignal.timeout(10000),
        });
        const text = await res.text().catch(() => '');
        const json = parseJsonSafe(text, null);
        if (!res.ok) {
          outcome = 'failed';
          error = `HTTP ${res.status}: ${text.slice(0, 180)}`;
        } else {
          const okVal = webhookCfg.successPath
            ? resolvePathValue(json, webhookCfg.successPath)
            : true;
          outcome = okVal === false ? 'failed' : 'succeeded';
          points =
            Number(
              webhookCfg.pointsPath
                ? resolvePathValue(json, webhookCfg.pointsPath)
                : 0,
            ) || 0;
          message =
            String(
              (webhookCfg.messagePath &&
                resolvePathValue(json, webhookCfg.messagePath)) ||
                'Webhook 签到成功',
            );
        }
      } catch (err) {
        outcome = 'failed';
        error = String(err?.message ?? err);
      }
    } else {
      outcome = 'skipped';
      message =
        '未配置 Agent2API 桥接或本地 checkin-plugins 适配器；请连接本机 Agent2API 或在 backend/var/checkin-plugins/ 添加适配器。';
    }

    this.store.tx(() => {
      this.store.db
        .prepare(
          `INSERT INTO checkin_records(
            ts, date, accountId, accountName, providerId, providerLabel,
            kind, section, outcome, message, error, points, meta
          ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          now,
          date,
          accountRow.id,
          accountRow.label,
          accountRow.preset,
          presetSpec.name,
          kind,
          section,
          outcome,
          message,
          error,
          points,
          JSON.stringify({}),
        );
    });

    return {
      id: accountRow.id,
      name: accountRow.label,
      provider: accountRow.preset,
      outcome,
      message,
      error,
      points,
    };
  }

  // ---- Schedules (SQLite standalone) ----

  #listLocalSchedules() {
    const rows = this.store.db
      .prepare('SELECT * FROM checkin_schedules ORDER BY time ASC, id ASC')
      .all();
    const today = todayDateStr();
    return rows.map((r) => ({
      id: r.id,
      label: r.label,
      displayLabel: r.label,
      enabled: Boolean(r.enabled),
      time: r.time,
      timeEnd: r.timeEnd || '',
      providers: parseJsonSafe(r.providers, []),
      providerTimes: parseJsonSafe(r.providerTimes, {}),
      providerRows: [],
      retryTime: r.retryTime || '',
      retryGapMinutes: r.retryGapMinutes,
      retryLimit: r.retryLimit,
      lastFiredDate: r.lastFiredDate,
      lastFiredToday: r.lastFiredDate === today,
      pendingProviders: [],
      retryCount: 0,
      nextRunAt: null,
      lastResult: parseJsonSafe(r.lastResultJson, null),
    }));
  }

  #buildLocalCenter() {
    const today = todayDateStr();
    const accounts = this.pool.listAccounts();
    const plugins = this.listLocalPlugins();
    const pluginProviders = new Set(plugins.map((p) => p.providerId));
    const todayRecords = this.store.db
      .prepare('SELECT * FROM checkin_records WHERE date=? ORDER BY ts DESC')
      .all(today);
    const totalRecords =
      this.store.db.prepare('SELECT COUNT(*) AS n FROM checkin_records').get()
        ?.n ?? 0;

    const latestByAcc = new Map();
    for (const r of todayRecords) {
      if (r.accountId && !latestByAcc.has(r.accountId)) {
        latestByAcc.set(r.accountId, r);
      }
    }

    const groupMap = new Map();
    const outOfScope = [];

    for (const acc of accounts) {
      const presetSpec = this.pool.getPreset(acc.preset);
      const hasAdapter =
        presetSpec.supportsCheckin ||
        pluginProviders.has(acc.preset) ||
        pluginProviders.has(acc.id) ||
        Boolean(acc.meta?.checkinWebhook);
      if (!hasAdapter) {
        outOfScope.push({
          label: acc.label,
          reason: '无签到接口',
          count: 1,
        });
        continue;
      }
      const rec = latestByAcc.get(acc.id);
      const checkedInToday = Boolean(
        rec && (rec.outcome === 'succeeded' || rec.outcome === 'already_done'),
      );
      const grp = groupMap.get(acc.preset) ?? {
        id: acc.preset,
        label: presetSpec.name,
        description:
          plugins.find((p) => p.providerId === acc.preset)?.description ??
          presetSpec.description ??
          '支持 Agent2API 协议桥接或本地 Webhook 适配器签到',
        accounts: [],
        doneCount: 0,
        totalCount: 0,
        modes: ['checkin'],
      };
      grp.totalCount += 1;
      if (checkedInToday) grp.doneCount += 1;
      grp.accounts.push({
        id: acc.id,
        name: acc.label,
        available: acc.enabled,
        checkinAt: rec?.ts ?? null,
        checkedInToday,
        dailyCheckin: rec
          ? {
              at: rec.ts,
              completed: checkedInToday,
              completedCount: checkedInToday ? 1 : 0,
              totalCount: 1,
              sourcesComplete: checkedInToday,
              status:
                rec.outcome === 'succeeded'
                  ? 'claimed'
                  : rec.outcome === 'already_done'
                    ? 'done'
                    : rec.outcome === 'failed'
                      ? 'failed'
                      : 'inactive',
              message: rec.message || rec.error || '',
            }
          : null,
        edition: null,
        streakDays: 0,
      });
      groupMap.set(acc.preset, grp);
    }

    const providers = [...groupMap.values()];
    const todayDone = providers.reduce((s, g) => s + g.doneCount, 0);
    const todayEligible = providers.reduce((s, g) => s + g.totalCount, 0);
    const autoEnabled = Boolean(
      this.store.getSetting('checkin.auto_enabled', false),
    );
    const schedules = this.#listLocalSchedules();

    return {
      mode: 'local',
      bridge: {
        ...this.getBridgeConfig(),
        connected: false,
      },
      daily: {
        providers,
        outOfScope,
        todayDone,
        todayEligible,
      },
      extras: {
        onboarding: [],
        plans: [],
        growth: [],
      },
      auto: {
        enabled: autoEnabled,
        lastFiredToday: schedules.some((s) => s.lastFiredToday),
        running: this.running,
        providerOptions: providers.map((p) => ({ id: p.id, label: p.label })),
        defaultRetryTime: '21:00',
        schedules,
      },
      recordsTotal: totalRecords,
      plugins: plugins.map(({ def: _def, ...rest }) => rest),
    };
  }

  // ---- Unified Public API (Bridged first, graceful fallback to Local) ----

  async getCenter() {
    const bridgeCfg = this.getBridgeConfig();
    const target = this.#getActiveBridgeTarget();
    if (target) {
      try {
        const remote = await this.#bridgeCall('/api/checkin-center', {
          timeoutMs: 8000,
        });
        let recordsTotal = remote?.history?.length ?? 0;
        try {
          const recPage = await this.#bridgeCall(
            '/api/checkin-records?offset=0&limit=1',
            { timeoutMs: 4000 },
          );
          if (typeof recPage?.total === 'number') recordsTotal = recPage.total;
        } catch {
          // optional count
        }
        return {
          mode: 'bridge',
          bridge: {
            ...bridgeCfg,
            baseUrl: target.baseUrl,
            connected: true,
            error: null,
          },
          daily: remote.daily ?? {
            providers: [],
            outOfScope: [],
            todayDone: 0,
            todayEligible: 0,
          },
          extras: remote.extras ?? { onboarding: [], plans: [], growth: [] },
          auto: remote.auto ?? {
            enabled: false,
            lastFiredToday: false,
            running: false,
            providerOptions: [],
            schedules: [],
          },
          keepalive: remote.keepalive ?? null,
          travel: remote.travel ?? null,
          history: remote.history ?? [],
          recordsTotal,
          plugins: this.listLocalPlugins().map(({ def: _def, ...rest }) => rest),
        };
      } catch (err) {
        const local = this.#buildLocalCenter();
        local.bridge = {
          ...bridgeCfg,
          baseUrl: target.baseUrl,
          connected: false,
          error: String(err?.message ?? err),
        };
        return local;
      }
    }
    return this.#buildLocalCenter();
  }

  async runCheckin({ accountId = null, providerId = null, kind = 'manual', section = 'daily' } = {}) {
    const target = this.#getActiveBridgeTarget();
    if (target) {
      try {
        return await this.#bridgeCall('/api/accounts/checkin', {
          method: 'POST',
          body: accountId ? { id: accountId } : {},
          timeoutMs: 30000,
        });
      } catch (err) {
        throw new Fault('BRIDGE_CHECKIN_FAILED', 502, {
          message: String(err?.message ?? err),
        });
      }
    }

    if (this.running) throw new Fault('CHECKIN_ALREADY_RUNNING', 409);
    this.running = true;
    try {
      const rows = this.store.db
        .prepare('SELECT * FROM provider_accounts WHERE enabled=1')
        .all()
        .filter((r) => {
          if (accountId && r.id !== accountId) return false;
          if (providerId && r.preset !== providerId) return false;
          return true;
        });
      const results = [];
      for (const row of rows) {
        results.push(await this.#executeLocalCheckin(row, { kind, section }));
      }
      const succeeded = results.filter(
        (r) => r.outcome === 'succeeded' || r.outcome === 'already_done',
      ).length;
      const failedCount = results.filter((r) => r.outcome === 'failed').length;
      const skipped = results.filter((r) => r.outcome === 'skipped').length;
      return {
        at: Date.now(),
        reason: kind,
        total: results.length,
        succeeded,
        failedCount,
        skipped,
        outcome: failedCount > 0 && succeeded === 0 ? 'failed' : 'completed',
        results,
      };
    } finally {
      this.running = false;
    }
  }

  async runActivity({ accountId, mode }) {
    const target = this.#getActiveBridgeTarget();
    if (target) {
      return await this.#bridgeCall('/api/checkin-activity', {
        method: 'POST',
        body: { id: accountId, mode },
        timeoutMs: 20000,
      });
    }
    return this.runCheckin({ accountId, section: mode || 'activity' });
  }

  async setAutoCheckin(enabled) {
    const target = this.#getActiveBridgeTarget();
    if (target) {
      try {
        return await this.#bridgeCall('/api/auto-checkin', {
          method: 'POST',
          body: { enabled: Boolean(enabled) },
        });
      } catch {
        // fall through to local
      }
    }
    this.store.setSetting('checkin.auto_enabled', Boolean(enabled));
    this.#syncTimer();
    return (await this.getCenter()).auto;
  }

  async saveSchedule(patch) {
    const target = this.#getActiveBridgeTarget();
    if (target) {
      try {
        return await this.#bridgeCall('/api/checkin-schedules', {
          method: 'POST',
          body: patch,
        });
      } catch {
        // fall through to local
      }
    }
    const schedId = patch.id?.trim() || uuid();
    const now = Date.now();
    this.store.tx(() => {
      this.store.db
        .prepare(
          `INSERT INTO checkin_schedules(
            id, label, enabled, time, timeEnd, providers, providerTimes,
            retryTime, retryGapMinutes, retryLimit, updatedAt
          ) VALUES(?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET
            label=excluded.label, enabled=excluded.enabled, time=excluded.time,
            timeEnd=excluded.timeEnd, providers=excluded.providers,
            providerTimes=excluded.providerTimes, retryTime=excluded.retryTime,
            retryGapMinutes=excluded.retryGapMinutes, retryLimit=excluded.retryLimit,
            updatedAt=excluded.updatedAt`,
        )
        .run(
          schedId,
          String(patch.label || '每日定时签到').trim(),
          patch.enabled === false ? 0 : 1,
          String(patch.time || '09:00'),
          patch.timeEnd ? String(patch.timeEnd) : null,
          JSON.stringify(Array.isArray(patch.providers) ? patch.providers : []),
          JSON.stringify(patch.providerTimes ?? {}),
          patch.retryTime !== undefined ? String(patch.retryTime) : '21:00',
          Number(patch.retryGapMinutes ?? 30),
          Number(patch.retryLimit ?? 2),
          now,
        );
    });
    this.#syncTimer();
    return (await this.getCenter()).auto;
  }

  async deleteSchedule(scheduleId) {
    const target = this.#getActiveBridgeTarget();
    if (target) {
      try {
        return await this.#bridgeCall(
          `/api/checkin-schedules/${encodeURIComponent(scheduleId)}/delete`,
          { method: 'POST' },
        );
      } catch {
        // fall through to local
      }
    }
    this.store.tx(() => {
      this.store.db
        .prepare('DELETE FROM checkin_schedules WHERE id=?')
        .run(scheduleId);
    });
    this.#syncTimer();
    return { id: scheduleId, deleted: true };
  }

  async runSchedule(scheduleId) {
    const target = this.#getActiveBridgeTarget();
    if (target) {
      try {
        return await this.#bridgeCall(
          `/api/checkin-schedules/${encodeURIComponent(scheduleId)}/run`,
          { method: 'POST', timeoutMs: 30000 },
        );
      } catch {
        // fall through to local
      }
    }
    const res = await this.runCheckin({ kind: 'schedule' });
    this.store.tx(() => {
      this.store.db
        .prepare(
          'UPDATE checkin_schedules SET lastFiredDate=?, lastResultJson=?, updatedAt=? WHERE id=?',
        )
        .run(todayDateStr(), JSON.stringify(res), Date.now(), scheduleId);
    });
    return res;
  }

  async getRecords(filters = {}) {
    const target = this.#getActiveBridgeTarget();
    if (target) {
      try {
        const sp = new URLSearchParams();
        for (const [k, v] of Object.entries(filters)) {
          if (v !== undefined && v !== null && v !== '') sp.set(k, String(v));
        }
        const qs = sp.toString() ? `?${sp.toString()}` : '';
        return await this.#bridgeCall(`/api/checkin-records${qs}`);
      } catch {
        // fall back to local records
      }
    }
    const limit = Math.min(200, Math.max(1, Number(filters.limit ?? 50)));
    const offset = Math.max(0, Number(filters.offset ?? 0));
    const where = [];
    const params = [];
    if (filters.outcome) {
      where.push('outcome=?');
      params.push(filters.outcome);
    }
    if (filters.kind) {
      where.push('kind=?');
      params.push(filters.kind);
    }
    if (filters.provider) {
      where.push('providerId=?');
      params.push(filters.provider);
    }
    if (filters.keyword) {
      where.push('(accountName LIKE ? OR message LIKE ? OR error LIKE ?)');
      const pat = `%${filters.keyword}%`;
      params.push(pat, pat, pat);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total =
      this.store.db
        .prepare(`SELECT COUNT(*) AS n FROM checkin_records ${clause}`)
        .get(...params)?.n ?? 0;
    const rows = this.store.db
      .prepare(
        `SELECT * FROM checkin_records ${clause} ORDER BY ts DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset);
    return {
      total,
      records: rows.map((r) => ({
        rowId: r.id,
        ts: r.ts,
        date: r.date,
        accountId: r.accountId,
        accountName: r.accountName,
        provider: r.providerLabel,
        providerId: r.providerId,
        source: r.kind,
        outcome: r.outcome,
        reason: r.section,
        message: r.message,
        error: r.error,
        points: r.points,
      })),
    };
  }

  async clearRecords(filters = {}) {
    const target = this.#getActiveBridgeTarget();
    if (target) {
      try {
        const sp = new URLSearchParams();
        if (filters.all) sp.set('all', '1');
        return await this.#bridgeCall(`/api/checkin-records?${sp.toString()}`, {
          method: 'DELETE',
        });
      } catch {
        // fall through
      }
    }
    const res = this.store.tx(() =>
      this.store.db.prepare('DELETE FROM checkin_records').run(),
    );
    return { removed: res.changes ?? 0 };
  }

  async proxyOnboarding(accountId, claim = false) {
    const target = this.#getActiveBridgeTarget();
    if (!target) {
      return { tasks: [], message: '请连接本机 Agent2API 查看/领取新手福利' };
    }
    return await this.#bridgeCall(
      `/api/accounts/${encodeURIComponent(accountId)}/onboarding${claim ? '/claim' : ''}`,
      { method: claim ? 'POST' : 'GET' },
    );
  }

  async proxyGrowth(accountId, body = null) {
    const target = this.#getActiveBridgeTarget();
    if (!target) {
      return { tasks: { tasks: [] }, message: '请连接本机 Agent2API 查看成长任务' };
    }
    return await this.#bridgeCall(
      `/api/accounts/${encodeURIComponent(accountId)}/growth${body ? '/task' : ''}`,
      { method: body ? 'POST' : 'GET', body: body ?? undefined },
    );
  }

  async #tickSchedules() {
    if (this.running) return;
    if (this.#getActiveBridgeTarget()) return; // Agent2API runs its own scheduler
    const autoEnabled = Boolean(
      this.store.getSetting('checkin.auto_enabled', false),
    );
    if (!autoEnabled) return;
    const today = todayDateStr();
    const hhmm = currentHHMM();
    const due = this.store.db
      .prepare(
        'SELECT * FROM checkin_schedules WHERE enabled=1 AND (lastFiredDate IS NULL OR lastFiredDate != ?) AND time <= ?',
      )
      .all(today, hhmm);
    for (const s of due) {
      await this.runSchedule(s.id).catch(() => {});
    }
  }
}
