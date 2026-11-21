import { resolve } from 'node:path';
import { intersectPolicies } from '../tools/policy.js';
import { classifyTrafficSource } from '../observability/trace.js';

function parseJsonSafe(str, fallback) {
  if (!str) return fallback;
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

function sameWorkspacePath(a, b) {
  if (!a || !b) return false;
  const ra = resolve(String(a));
  const rb = resolve(String(b));
  return process.platform === 'win32' ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
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
    const maxConcurrency =
      body.maxConcurrency !== undefined ? Number(body.maxConcurrency) : 3;
    const maxReplans =
      body.maxReplans !== undefined ? Number(body.maxReplans) : 2;
    if (!Number.isFinite(maxConcurrency) || maxConcurrency < 1 || !Number.isFinite(maxReplans) || maxReplans < 0) {
      return reply.code(400).send({
        error: {
          code: 'INVALID_SWARM_CONFIG',
          message: 'maxConcurrency must be a finite number >= 1 and maxReplans must be >= 0',
          status: 400,
        },
      });
    }

    const traffic = classifyTrafficSource(req.headers);
    const session = body.sessionId
      ? directAgent.getSession(String(body.sessionId))
      : directAgent.createSession({
          title: `[Swarm] ${goal.slice(0, 60)}`,
          workspaceRoot: body.workspaceRoot ?? null,
          permissionMode: body.permissionMode ?? 'auto-safe',
        });

    if (
      body.sessionId &&
      body.workspaceRoot &&
      session.workspaceRoot &&
      !sameWorkspacePath(body.workspaceRoot, session.workspaceRoot)
    ) {
      return reply.code(403).send({
        error: {
          code: 'WORKSPACE_MISMATCH',
          message: 'Requested workspaceRoot does not match session workspaceRoot',
          status: 403,
        },
      });
    }

    const effectivePermissionMode = body.permissionMode
      ? intersectPolicies(
          { permissionMode: session.permissionMode || 'auto-safe' },
          { permissionMode: String(body.permissionMode) },
        ).permissionMode
      : session.permissionMode || 'auto-safe';

    const opts = {
      sessionId: session.id,
      goal,
      workspaceRoot: session.workspaceRoot || body.workspaceRoot || directAgent.getWorkspaceRoot(),
      parentPermissionMode: effectivePermissionMode,
      maxConcurrency,
      budget: body.budget ?? {},
      nodes: Array.isArray(body.nodes) ? body.nodes : null,
      maxReplans,
      trafficSource: traffic.trafficSource,
      isSynthetic: traffic.isSynthetic ? 1 : 0,
    };

    if (body.wait === true || req.query?.wait === 'true') {
      const result = await directAgent.swarmOrchestrator.startRun(opts);
      return reply.code(201).send(result);
    }

    const submitted = directAgent.swarmOrchestrator.submitRun(opts);
    return reply.code(202).send(submitted);
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

  app.post('/v1/swarm/runs/:id/resume', async (req, reply) => {
    const run = directAgent?.swarmOrchestrator?.resumeRun(req.params.id);
    if (!run) {
      return reply.code(404).send({
        error: { code: 'SWARM_RUN_NOT_FOUND', message: 'Swarm run not found', status: 404 },
      });
    }
    return run;
  });

  app.get('/v1/swarm/runs/:id/replans', async (req) => ({
    items: directAgent?.swarmOrchestrator?.listReplans(req.params.id) ?? [],
  }));

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

  // ---- Isolated Worktree Artifacts: List, Read, Verify, and Guarded Apply-to-Parent ----

  app.get('/v1/swarm/runs/:id/artifacts', async (req) => {
    const q = req.query ?? {};
    return {
      items:
        directAgent?.artifactManager?.listArtifacts({
          runId: req.params.id,
          nodeKey: q.nodeKey ? String(q.nodeKey) : null,
          limit: Number(q.limit ?? 200),
        }) ?? [],
    };
  });

  app.get('/v1/swarm/runs/:id/artifacts/:artifactId', async (req, reply) => {
    const mgr = directAgent?.artifactManager;
    if (!mgr) {
      return reply.code(503).send({
        error: { code: 'ARTIFACT_MANAGER_UNAVAILABLE', message: 'Artifact manager not ready', status: 503 },
      });
    }
    const art = mgr.getArtifact(req.params.artifactId);
    if (!art || art.runId !== req.params.id) {
      return reply.code(404).send({
        error: { code: 'ARTIFACT_NOT_FOUND', message: 'Swarm artifact not found', status: 404 },
      });
    }
    const filePath = req.query?.path ? String(req.query.path) : null;
    if (filePath) {
      const fileRes = mgr.readArtifactFile(art.id, filePath);
      return {
        artifactId: art.id,
        uri: art.uri,
        entry: fileRes.entry,
        deleted: fileRes.deleted,
        text: fileRes.text,
        base64: fileRes.base64,
        verified: fileRes.verified,
      };
    }
    return art;
  });

  app.post('/v1/swarm/runs/:id/artifacts/:artifactId/verify', async (req, reply) => {
    const mgr = directAgent?.artifactManager;
    if (!mgr) {
      return reply.code(503).send({
        error: { code: 'ARTIFACT_MANAGER_UNAVAILABLE', message: 'Artifact manager not ready', status: 503 },
      });
    }
    const art = mgr.getArtifact(req.params.artifactId);
    if (!art || art.runId !== req.params.id) {
      return reply.code(404).send({
        error: { code: 'ARTIFACT_NOT_FOUND', message: 'Swarm artifact not found', status: 404 },
      });
    }
    return mgr.verifyArtifact(art.id);
  });

  app.post('/v1/swarm/runs/:id/artifacts/:artifactId/apply', async (req, reply) => {
    const mgr = directAgent?.artifactManager;
    if (!mgr) {
      return reply.code(503).send({
        error: { code: 'ARTIFACT_MANAGER_UNAVAILABLE', message: 'Artifact manager not ready', status: 503 },
      });
    }
    const art = mgr.getArtifact(req.params.artifactId);
    if (!art || art.runId !== req.params.id) {
      return reply.code(404).send({
        error: { code: 'ARTIFACT_NOT_FOUND', message: 'Swarm artifact not found', status: 404 },
      });
    }
    const body = req.body ?? {};
    const run = directAgent?.swarmOrchestrator?.getRun?.(req.params.id) ?? null;
    const expectedRoot = art.workspaceRoot || run?.workspaceRoot || null;
    if (body.workspaceRoot && expectedRoot && !sameWorkspacePath(body.workspaceRoot, expectedRoot)) {
      return reply.code(403).send({
        error: {
          code: 'WORKSPACE_MISMATCH',
          message: 'Requested workspaceRoot does not match artifact workspaceRoot',
          status: 403,
        },
      });
    }
    const effectivePermissionMode =
      run?.permissionMode && body.permissionMode
        ? intersectPolicies(
            { permissionMode: run.permissionMode },
            { permissionMode: String(body.permissionMode) },
          ).permissionMode
        : body.permissionMode
          ? String(body.permissionMode)
          : run?.permissionMode ?? null;

    const result = mgr.applyToParent(art.id, {
      workspaceRoot: expectedRoot || (body.workspaceRoot ? String(body.workspaceRoot) : null),
      permissionMode: effectivePermissionMode,
      approved: Boolean(body.approved),
      dryRun: Boolean(body.dryRun),
    });
    if (result.status === 'conflict') {
      return reply.code(409).send(result);
    }
    return reply.code(200).send(result);
  });

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
