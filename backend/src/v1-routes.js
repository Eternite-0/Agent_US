import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Fault, id as uuid } from './store.js';
import { decide as decideLegacyApproval } from './tools.js';
import { AuditLedgerService } from './governance/audit.js';
import { ScheduledTaskRunner } from './governance/scheduler.js';
import { registerRuntimeRoutes } from './routes/runtime-routes.js';
import { registerSwarmRoutes } from './routes/swarm-routes.js';
import { registerScheduleRoutes } from './routes/schedule-routes.js';

const execFileAsync = promisify(execFile);

async function runGit(cwd, args) {
  const { stdout, stderr } = await execFileAsync('git', args, {
    cwd,
    windowsHide: true,
    timeout: 8000,
  });
  return { stdout: stdout.trim(), stderr: stderr.trim() };
}

async function getGitStatusFor(cwd) {
  try {
    const rev = await runGit(cwd, ['rev-parse', '--is-inside-work-tree']);
    if (rev.stdout !== 'true') {
      return { available: false, branch: null, dirty: false, branches: [] };
    }
    let branch = null;
    try {
      branch = (await runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout;
    } catch {
      branch = null;
    }
    const statusOut = (await runGit(cwd, ['status', '--porcelain'])).stdout;
    const uncommittedCount = statusOut
      ? statusOut.split(/\r?\n/).filter(Boolean).length
      : 0;
    let branches = [];
    try {
      const bOut = (
        await runGit(cwd, ['branch', '--format=%(refname:short)'])
      ).stdout;
      branches = bOut
        ? bOut
            .split(/\r?\n/)
            .map((s) => s.trim())
            .filter(Boolean)
        : [];
    } catch {
      branches = branch ? [branch] : [];
    }
    return {
      available: true,
      branch,
      dirty: uncommittedCount > 0,
      uncommittedCount,
      branches,
    };
  } catch {
    return { available: false, branch: null, dirty: false, branches: [] };
  }
}

function writeSseFrame(res, ev) {
  if (res.destroyed || res.writableEnded) return false;
  const idLine = ev.seq > 0 ? `id: ${ev.seq}\n` : '';
  return res.write(`${idLine}event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
}

export function v1Routes(
  app,
  {
    store,
    providers,
    pool,
    directAgent,
    checkin,
    webLogin = null,
    controlPlane = null,
    startedAt = Date.now(),
  },
) {
  if (!pool || !directAgent) return;

  const streams = new Set();
  app.addHook('preClose', async () => {
    for (const cleanup of streams) cleanup();
    streams.clear();
  });

  // ---- Health & Workspace ----

  app.get('/v1/health', async () => ({
    ok: store.db.prepare('SELECT 1 AS ok').get().ok === 1,
    status: 'ok',
    version: '0.2.0',
    uptimeMs: Date.now() - startedAt,
    workspaceRoot: directAgent.getWorkspaceRoot(),
    routerReady: pool.getActiveCatalog().items.length > 0,
    gateway: {
      running: true,
      port: Number(process.env.PORT ?? 8787),
      endpoint: `http://127.0.0.1:${Number(process.env.PORT ?? 8787)}/v1`,
    },
  }));

  app.get('/v1/workspace', async () => ({
    workspaceRoot: directAgent.getWorkspaceRoot(),
  }));

  app.put('/v1/workspace', async (req) => {
    const body = req.body ?? {};
    return directAgent.setWorkspaceRoot(body.workspaceRoot);
  });

  // ---- Direct Multi-Turn Sessions & Streaming Turns ----

  app.get('/v1/sessions', async (req) => {
    const q = req.query ?? {};
    return {
      items: directAgent.listSessions({
        limit: q.limit ? Number(q.limit) : 200,
        offset: q.offset ? Number(q.offset) : 0,
      }),
    };
  });

  app.post('/v1/sessions', async (req) => {
    const body = req.body ?? {};
    return directAgent.createSession({
      id: body.id,
      title: body.title,
      model: body.model,
      workspaceRoot: body.workspaceRoot,
      mode: body.mode,
      permissionMode: body.permissionMode,
    });
  });

  app.get('/v1/sessions/:id', async (req) =>
    directAgent.getSession(req.params.id),
  );

  app.patch('/v1/sessions/:id', async (req) =>
    directAgent.updateSession(req.params.id, req.body ?? {}),
  );

  app.delete('/v1/sessions/:id', async (req) =>
    directAgent.deleteSession(req.params.id),
  );

  app.get('/v1/sessions/:id/turns', async (req) => {
    const q = req.query ?? {};
    return {
      items: directAgent.listTurns(req.params.id, {
        limit: q.limit ? Number(q.limit) : 50,
      }),
    };
  });

  app.post('/v1/sessions/:id/turns', async (req) => {
    const body = req.body ?? {};
    return directAgent.startTurn(req.params.id, {
      input: body.input,
      clientTurnId: body.clientTurnId,
      model: body.model,
      permissionMode: body.permissionMode,
      effort: body.effort,
      maxSteps: body.maxSteps,
      files: body.files,
    });
  });

  app.post('/v1/sessions/:id/steer', async (req) => {
    const body = req.body ?? {};
    return directAgent.steerSession(req.params.id, body.input ?? body.text ?? '');
  });

  app.post('/v1/sessions/:id/compact', async (req) =>
    directAgent.compactSession(req.params.id),
  );

  app.get('/v1/sessions/:id/snapshots', async (req) => ({
    items: directAgent.listSnapshots(req.params.id),
  }));

  app.post('/v1/sessions/:id/rewind', async (req) => {
    const body = req.body ?? {};
    return directAgent.rewindSession(req.params.id, {
      turnId: body.turnId ?? null,
      scope: body.scope ?? 'both',
    });
  });

  app.get('/v1/history/search', async (req) => {
    const q = req.query ?? {};
    return {
      items: store.searchDirectHistory(String(q.q ?? ''), {
        excludeSessionId: q.excludeSessionId || null,
        limit: q.limit ? Number(q.limit) : 20,
      }),
    };
  });

  app.post('/v1/turns/:id/cancel', async (req) =>
    directAgent.cancelTurn(req.params.id),
  );

  app.get('/v1/sessions/:id/messages', async (req) => {
    const q = req.query ?? {};
    return {
      items: directAgent.listMessages(req.params.id, {
        after: q.after ? Number(q.after) : 0,
        limit: q.limit ? Number(q.limit) : 200,
      }),
    };
  });

  app.get('/v1/sessions/:id/events', async (req) => {
    const q = req.query ?? {};
    return {
      items: directAgent.listEvents(req.params.id, {
        after: q.after ? Number(q.after) : 0,
        limit: q.limit ? Number(q.limit) : 300,
      }),
    };
  });

  const handleSse = (sessionId) => async (req, reply) => {
    const q = req.query ?? {};
    const after = Number(q.after ?? req.headers['last-event-id'] ?? 0) || 0;
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');

    let lastSeq = after;
    const backlog = directAgent.listEvents(sessionId, { after, limit: 300 });
    for (const ev of backlog) {
      if (ev.seq > lastSeq) lastSeq = ev.seq;
      writeSseFrame(res, ev);
    }

    const unsubscribe = directAgent.subscribe(sessionId, (ev) => {
      if (ev.ephemeral) {
        writeSseFrame(res, ev);
        return;
      }
      if (ev.seq > lastSeq) {
        lastSeq = ev.seq;
        writeSseFrame(res, ev);
      }
    });

    const heartbeat = setInterval(() => {
      if (!res.destroyed && !res.writableEnded) {
        res.write(': heartbeat\n\n');
      }
    }, 15000);

    const cleanup = () => {
      clearInterval(heartbeat);
      unsubscribe();
      streams.delete(cleanup);
      if (!res.destroyed && !res.writableEnded) res.end();
    };
    streams.add(cleanup);
    res.on('close', cleanup);
  };

  app.get('/v1/sessions/:id/stream', async (req, reply) =>
    handleSse(req.params.id)(req, reply),
  );
  app.get('/v1/stream', handleSse(null));

  // ---- Approvals (Direct + Legacy fallback) ----

  app.get('/v1/approvals', async (req) => {
    const q = req.query ?? {};
    const items = directAgent.listApprovals({
      sessionId: q.sessionId || null,
      status: q.status || null,
      limit: q.limit ? Number(q.limit) : 200,
    });
    return { items };
  });

  app.post('/v1/approvals/:id/decision', async (req) => {
    const body = req.body ?? {};
    const direct = directAgent.decideApproval(req.params.id, {
      decision: body.decision,
      scope: body.scope ?? 'once',
      reason: body.reason ?? '',
    });
    if (direct) return direct;
    // Fallback to legacy DAG approval if ID belongs to legacy engine
    const legacy = store.get('approvals', req.params.id);
    return decideLegacyApproval(store, req.params.id, {
      version: body.version ?? legacy.version,
      decision:
        body.decision === 'allow' || body.decision === 'approve'
          ? 'approve'
          : 'deny',
      reason: body.reason,
    });
  });

  // ---- Providers & Account Pool ----

  app.get('/v1/providers/presets', async () => pool.listPresets());

  app.get('/v1/providers', async () => {
    const accounts = pool.listAccounts();
    const catalog = pool.getActiveCatalog();
    return {
      routerReady: catalog.items.length > 0,
      items: accounts,
    };
  });

  app.get('/v1/providers/health', async () => {
    const accounts = pool.listAccounts();
    const catalog = pool.getActiveCatalog();
    return {
      routerReady: catalog.items.length > 0,
      items: accounts,
      providers: providers?.list ? providers.list() : [],
    };
  });

  app.get('/v1/accounts', async (req) => {
    const q = req.query ?? {};
    const all = pool.listAccounts();
    const filtered = pool.listAccounts({
      preset: q.preset,
      model: q.model,
      enabled: q.enabled,
      rateLimited: q.rateLimited,
      search: q.search,
    });
    return {
      items: filtered,
      summary: {
        total: all.length,
        enabled: all.filter((a) => a.enabled).length,
        disabled: all.filter((a) => !a.enabled).length,
        rateLimited: all.filter((a) => a.rateLimited).length,
        normal: all.filter((a) => !a.rateLimited).length,
      },
    };
  });

  app.post('/v1/accounts', async (req) => pool.createAccount(req.body ?? {}));

  app.patch('/v1/accounts/:id', async (req) =>
    pool.updateAccount(req.params.id, req.body ?? {}),
  );

  app.delete('/v1/accounts/:id', async (req) =>
    pool.deleteAccount(req.params.id),
  );

  app.post('/v1/accounts/batch', async (req) =>
    pool.batchAccounts(req.body ?? {}),
  );

  app.put('/v1/accounts/priorities', async (req) =>
    pool.setProviderPriorities(req.body?.order ?? []),
  );

  app.post('/v1/accounts/:id/test', async (req) =>
    pool.testAccount(req.params.id),
  );

  app.post('/v1/accounts/:id/sync-models', async (req) =>
    pool.syncAccountModels(req.params.id),
  );

  app.post('/v1/accounts/:id/balance', async (req) =>
    pool.queryAccountBalance(req.params.id),
  );

  app.post('/v1/accounts/balances', async () => pool.queryAllBalances());

  app.post('/v1/accounts/import-local', async () =>
    pool.importLocalAccounts(),
  );

  // ---- Self-Contained Web Login (OpenRouter PKCE / GitHub Copilot Device Flow) & Credential Import ----

  if (webLogin) {
    app.get('/v1/auth/local-credentials', async () =>
      webLogin.scanLocalCredentials(),
    );

    app.post('/v1/auth/import-local', async (req) =>
      webLogin.importLocalCredential(req.body ?? {}),
    );

    app.post('/v1/auth/web-login/start', async (req) => {
      const body = req.body ?? {};
      const host = req.headers.host || `127.0.0.1:${Number(process.env.PORT ?? 8787)}`;
      const proto = req.headers['x-forwarded-proto'] || 'http';
      return webLogin.startWebLogin({
        ...body,
        callbackOrigin: body.callbackOrigin || `${proto}://${host}`,
      });
    });

    app.get('/v1/auth/web-login/:flowId/status', async (req) =>
      webLogin.getWebLoginStatus(req.params.flowId),
    );

    app.post('/v1/auth/web-login/:flowId/callback', async (req) =>
      webLogin.submitWebLoginCallback(req.params.flowId, req.body ?? {}),
    );

    app.post('/v1/auth/web-login/:flowId/cancel', async (req) =>
      webLogin.cancelWebLogin(req.params.flowId),
    );

    app.get('/v1/auth/oauth/callback', async (req, reply) => {
      const q = req.query ?? {};
      const out = await webLogin.handleOAuthCallback({
        state: String(q.state ?? ''),
        code: String(q.code ?? ''),
        error: String(q.error ?? ''),
      });
      reply.type('text/html; charset=utf-8').send(out.html);
    });

    app.post('/v1/auth/import-credential', async (req) =>
      webLogin.importCredentialFile(req.body ?? {}),
    );
  }

  // ---- Model Management Hub & OpenAI Local Gateway ----

  app.get('/v1/models', async () => pool.getActiveCatalog());

  app.get('/v1/models/pool', async (req) => {
    const q = req.query ?? {};
    const port = Number(process.env.PORT ?? 8787);
    return {
      ...pool.listPoolModels({
        preset: q.preset,
        status: q.status,
        visibility: q.visibility,
        search: q.search,
      }),
      gateway: {
        running: true,
        host: '127.0.0.1',
        port,
        endpoint: `http://127.0.0.1:${port}/v1`,
      },
    };
  });

  app.post('/v1/models/sync', async (req) =>
    pool.syncProviderModels(req.body?.preset ?? null),
  );

  app.post('/v1/models/manual', async (req) =>
    pool.addManualModel(req.body ?? {}),
  );

  app.patch('/v1/models/:id', async (req) =>
    pool.updatePoolModel(req.params.id, req.body ?? {}),
  );

  app.delete('/v1/models/:id', async (req) =>
    pool.deletePoolModel(req.params.id),
  );

  app.post('/v1/models/mappings', async (req) =>
    pool.upsertMapping(req.body ?? {}),
  );

  app.delete('/v1/models/mappings/:id', async (req) =>
    pool.deleteMapping(req.params.id),
  );

  app.put('/v1/models/default', async (req) =>
    pool.setDefaultModel(req.body?.model ?? ''),
  );

  app.post('/v1/models/test', async (req) =>
    pool.testModel(req.body ?? {}),
  );

  // Local Reverse-Proxy Gateway: OpenAI (/v1/chat/completions) & Anthropic (/v1/messages)
  const pipeProxyResult = async (req, reply, body, { response, release }) => {
    if (body?.stream && response.body) {
      reply.hijack();
      reply.raw.writeHead(response.status, {
        'Content-Type':
          response.headers.get('content-type') || 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      const reader = response.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!reply.raw.destroyed) reply.raw.write(Buffer.from(value));
        }
      } finally {
        reader.releaseLock();
        release?.();
        if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.end();
      }
      return;
    }
    try {
      const text = await response.text();
      reply
        .code(response.status)
        .header(
          'content-type',
          response.headers.get('content-type') || 'application/json',
        )
        .send(text);
    } finally {
      release?.();
    }
  };

  app.post('/v1/chat/completions', async (req, reply) => {
    const body = req.body ?? {};
    const controller = new AbortController();
    reply.raw.on('close', () => {
      if (!reply.raw.writableEnded) controller.abort();
    });
    const out = await pool.proxyChatCompletion(body, {
      signal: controller.signal,
    });
    await pipeProxyResult(req, reply, body, out);
  });

  app.post('/v1/messages', async (req, reply) => {
    const body = req.body ?? {};
    const controller = new AbortController();
    reply.raw.on('close', () => {
      if (!reply.raw.writableEnded) controller.abort();
    });
    const out = await pool.proxyAnthropicMessages(body, {
      signal: controller.signal,
    });
    await pipeProxyResult(req, reply, body, out);
  });

  // ---- Check-in Center (Agent2API Protocol Compatible) ----

  if (checkin) {
    app.get('/v1/checkin/center', async () => checkin.getCenter());
    app.post('/v1/checkin/run', async (req) =>
      checkin.runCheckin(req.body ?? {}),
    );
    app.post('/v1/checkin/activity', async (req) =>
      checkin.runActivity(req.body ?? {}),
    );
    app.post('/v1/checkin/auto', async (req) =>
      checkin.setAutoCheckin(Boolean(req.body?.enabled)),
    );
    app.post('/v1/checkin/schedules', async (req) =>
      checkin.saveSchedule(req.body ?? {}),
    );
    app.delete('/v1/checkin/schedules/:id', async (req) =>
      checkin.deleteSchedule(req.params.id),
    );
    app.post('/v1/checkin/schedules/:id/run', async (req) =>
      checkin.runSchedule(req.params.id),
    );
    app.get('/v1/checkin/records', async (req) =>
      checkin.getRecords(req.query ?? {}),
    );
    app.delete('/v1/checkin/records', async (req) =>
      checkin.clearRecords(req.query ?? {}),
    );
    app.get('/v1/checkin/bridge', async () => checkin.getBridgeConfig());
    app.put('/v1/checkin/bridge', async (req) =>
      checkin.setBridgeConfig(req.body ?? {}),
    );
    app.post('/v1/checkin/bridge/test', async () => checkin.testBridge());
    app.get('/v1/checkin/onboarding/:id', async (req) =>
      checkin.proxyOnboarding(req.params.id, false),
    );
    app.post('/v1/checkin/onboarding/:id/claim', async (req) =>
      checkin.proxyOnboarding(req.params.id, true),
    );
    app.get('/v1/checkin/growth/:id', async (req) =>
      checkin.proxyGrowth(req.params.id, null),
    );
    app.post('/v1/checkin/growth/:id/task', async (req) =>
      checkin.proxyGrowth(req.params.id, req.body ?? {}),
    );
  }

  // ---- Git on Active Workspace ----

  app.get('/v1/git/status', async () =>
    getGitStatusFor(directAgent.getWorkspaceRoot()),
  );

  app.post('/v1/git/checkout', async (req) => {
    const cwd = directAgent.getWorkspaceRoot();
    const branch = String(req.body?.branch || '').trim();
    if (!branch || !/^[a-zA-Z0-9._/-]{1,120}$/.test(branch)) {
      throw new Fault('INVALID_BRANCH_NAME', 400);
    }
    const args = req.body?.create ? ['checkout', '-b', branch] : ['checkout', branch];
    await runGit(cwd, args);
    return getGitStatusFor(cwd);
  });

  app.post('/v1/git/init', async (req) => {
    const cwd = directAgent.getWorkspaceRoot();
    const initialBranch = String(req.body?.initialBranch || 'main').trim();
    await runGit(cwd, ['init', '-b', initialBranch]);
    return getGitStatusFor(cwd);
  });

  // ---- Memory (Global / Workspace / Session) ----

  app.get('/v1/memory', async (req) => {
    const q = req.query ?? {};
    const where = [];
    const params = [];
    if (q.scope) {
      where.push('scopeType=?');
      params.push(String(q.scope));
    }
    if (q.sessionId) {
      where.push('scopeId=?');
      params.push(String(q.sessionId));
    }
    if (q.kind) {
      where.push('kind=?');
      params.push(String(q.kind));
    }
    if (q.q) {
      where.push('(key LIKE ? OR value LIKE ?)');
      const pat = `%${String(q.q)}%`;
      params.push(pat, pat);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = store.db
      .prepare(
        `SELECT * FROM nexus_memory ${clause} ORDER BY updatedAt DESC LIMIT ?`,
      )
      .all(...params, Math.min(200, Math.max(1, Number(q.limit ?? 100))));
    return {
      items: rows.map((r) => ({
        scope: { type: r.scopeType, id: r.scopeId },
        key: r.key,
        value: r.value,
        kind: r.kind,
        tags: JSON.parse(r.tags || '[]'),
        confidence: r.confidence,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        lastAccessedAt: r.lastAccessedAt,
      })),
    };
  });

  app.put('/v1/memory', async (req) => {
    const q = req.query ?? {};
    const body = req.body ?? {};
    const scopeType = String(q.scope || 'global');
    const scopeId = String(
      q.sessionId || (scopeType === 'workspace' ? directAgent.getWorkspaceRoot() : 'global'),
    );
    const key = String(body.key || '').trim();
    const value = String(body.value ?? '');
    if (!key) throw new Fault('MEMORY_KEY_REQUIRED', 400);
    const now = Date.now();
    store.tx(() => {
      store.db
        .prepare(
          `INSERT INTO nexus_memory(id, scopeType, scopeId, key, value, kind, tags, confidence, createdAt, updatedAt)
           VALUES(?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(scopeType, scopeId, key) DO UPDATE SET
             value=excluded.value, kind=excluded.kind, tags=excluded.tags, updatedAt=excluded.updatedAt`,
        )
        .run(
          uuid(),
          scopeType,
          scopeId,
          key,
          value,
          String(body.kind || 'note'),
          JSON.stringify(Array.isArray(body.tags) ? body.tags : []),
          Number(body.confidence ?? 1),
          now,
          now,
        );
    });
    return {
      scope: { type: scopeType, id: scopeId },
      key,
      value,
      kind: String(body.kind || 'note'),
      updatedAt: now,
    };
  });

  app.delete('/v1/memory', async (req) => {
    const q = req.query ?? {};
    const scopeType = String(q.scope || 'global');
    const key = String(q.key || '').trim();
    if (!key) throw new Fault('MEMORY_KEY_REQUIRED', 400);
    store.tx(() => {
      if (q.sessionId) {
        store.db
          .prepare(
            'DELETE FROM nexus_memory WHERE scopeType=? AND scopeId=? AND key=?',
          )
          .run(scopeType, String(q.sessionId), key);
      } else {
        store.db
          .prepare('DELETE FROM nexus_memory WHERE scopeType=? AND key=?')
          .run(scopeType, key);
      }
    });
    return { key, deleted: true };
  });

  // ---- Usage & Plans ----

  app.get('/v1/usage', async (req) => {
    const q = req.query ?? {};
    const where = [];
    const params = [];
    if (q.sessionId) {
      where.push('sessionId=?');
      params.push(String(q.sessionId));
    }
    if (q.provider) {
      where.push('provider=?');
      params.push(String(q.provider));
    }
    if (q.model) {
      where.push('model=?');
      params.push(String(q.model));
    }
    if (q.day) {
      where.push('day=?');
      params.push(String(q.day));
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = store.db
      .prepare(
        `SELECT sessionId, planId, provider, model, accountId, day,
                SUM(tokens) AS tokens, SUM(costUsd) AS costUsd,
                SUM(durationMs) AS durationMs, COUNT(*) AS callCount
         FROM nexus_usage ${clause}
         GROUP BY day, provider, model, sessionId
         ORDER BY day DESC LIMIT 200`,
      )
      .all(...params);
    const totals = rows.reduce(
      (acc, r) => ({
        tokens: acc.tokens + Number(r.tokens ?? 0),
        costUsd: acc.costUsd + Number(r.costUsd ?? 0),
        callCount: acc.callCount + Number(r.callCount ?? 0),
      }),
      { tokens: 0, costUsd: 0, callCount: 0 },
    );
    return { items: rows, summary: totals };
  });

  const effectiveControlPlane = controlPlane ?? {
    auditService: new AuditLedgerService(store),
    scheduler: new ScheduledTaskRunner({ store, directAgent }),
    getOverview: null,
  };
  registerRuntimeRoutes(app, {
    store,
    directAgent,
    controlPlane: controlPlane ?? effectiveControlPlane,
  });
  registerSwarmRoutes(app, { store, directAgent });
  registerScheduleRoutes(app, {
    scheduler: effectiveControlPlane.scheduler,
  });
}
