function parseJsonSafe(str, fallback) {
  if (!str) return fallback;
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

export function registerSwarmRoutes(app, { store, directAgent }) {
  app.get('/v1/swarm/capabilities', async () => ({
    models: directAgent?.modelCapabilities?.syncFromPool?.() ?? [],
    archetypes: directAgent?.agentCapabilities?.listCapabilities?.() ?? [],
  }));

  app.get('/v1/swarm/runs', async (req) => {
    const q = req.query ?? {};
    return {
      items:
        directAgent?.swarmOrchestrator?.listRuns({
          sessionId: q.sessionId ? String(q.sessionId) : null,
          limit: Number(q.limit ?? 50),
        }) ?? [],
    };
  });

  app.post('/v1/swarm/runs', async (req, reply) => {
    if (!directAgent?.swarmOrchestrator) {
      return reply.code(503).send({
        error: { code: 'SWARM_UNAVAILABLE', message: 'Swarm orchestrator not ready', status: 503 },
      });
    }
    const body = req.body ?? {};
    const goal = String(body.goal ?? '').trim();
    if (!goal) {
      return reply.code(400).send({
        error: { code: 'EMPTY_GOAL', message: 'Swarm goal is required', status: 400 },
      });
    }
    const session = body.sessionId
      ? directAgent.getSession(String(body.sessionId))
      : directAgent.createSession({
          title: `[Swarm] ${goal.slice(0, 60)}`,
          workspaceRoot: body.workspaceRoot ?? null,
          permissionMode: body.permissionMode ?? 'auto-safe',
        });

    const result = await directAgent.swarmOrchestrator.startRun({
      sessionId: session.id,
      goal,
      workspaceRoot: body.workspaceRoot || session.workspaceRoot || directAgent.getWorkspaceRoot(),
      parentPermissionMode: body.permissionMode || session.permissionMode || 'auto-safe',
      maxConcurrency: Number(body.maxConcurrency ?? 3),
      budget: body.budget ?? {},
      nodes: Array.isArray(body.nodes) ? body.nodes : null,
    });
    return reply.code(201).send(result);
  });

  app.get('/v1/swarm/runs/:id', async (req, reply) => {
    const run = directAgent?.swarmOrchestrator?.getRun(req.params.id);
    if (!run) {
      return reply.code(404).send({
        error: { code: 'SWARM_RUN_NOT_FOUND', message: 'Swarm run not found', status: 404 },
      });
    }
    return run;
  });

  app.post('/v1/swarm/runs/:id/cancel', async (req, reply) => {
    const run = directAgent?.swarmOrchestrator?.cancelRun(req.params.id);
    if (!run) {
      return reply.code(404).send({
        error: { code: 'SWARM_RUN_NOT_FOUND', message: 'Swarm run not found', status: 404 },
      });
    }
    return run;
  });

  app.get('/v1/swarm/runs/:id/messages', async (req) => ({
    items: directAgent?.mailbox?.listForRun(req.params.id) ?? [],
  }));

  // Replaces legacy empty stub with unified Swarm + Session active plans view
  app.get('/v1/plans', async (req) => {
    const q = req.query ?? {};
    const limit = Math.min(100, Math.max(1, Number(q.limit ?? 50)));
    const runs = directAgent?.swarmOrchestrator?.listRuns({ limit }) ?? [];
    const sessionPlans = store.db
      .prepare(
        "SELECT id, title, state, planJson, updatedAt FROM direct_sessions WHERE planJson IS NOT NULL AND planJson != '' ORDER BY updatedAt DESC LIMIT ?",
      )
      .all(limit)
      .map((s) => ({
        id: s.id,
        kind: 'session_plan',
        sessionId: s.id,
        title: s.title,
        status: s.state,
        plan: parseJsonSafe(s.planJson, null),
        updatedAt: s.updatedAt,
      }));
    const swarmPlans = runs.map((r) => ({
      id: r.id,
      kind: 'swarm_run',
      sessionId: r.sessionId,
      title: r.goal,
      status: r.status,
      nodes: r.nodes,
      usage: r.usage,
      updatedAt: r.updatedAt,
    }));
    return { items: [...swarmPlans, ...sessionPlans] };
  });
}
