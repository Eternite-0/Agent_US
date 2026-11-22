import { resolve } from 'node:path';
import { Fault } from '../store.js';
import { validatePlan } from '../planning/validator.js';
import { AdaptivePlanner } from '../planning/planner.js';
import { AdaptiveReplanner } from '../planning/replanner.js';
import { CommunicationValidationError, CommunicationStateError } from '../communication/envelope.js';
import { classifyTrafficSource } from '../observability/trace.js';
import { intersectPolicies } from '../tools/policy.js';

function sameWorkspacePath(a, b) {
  if (!a || !b) return false;
  const ra = resolve(String(a));
  const rb = resolve(String(b));
  return process.platform === 'win32' ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
}

function normalizeSessionPermissionMode(mode) {
  const m = String(mode || 'auto-safe').trim();
  if (m === 'readonly' || m === 'read-only') return 'read-only';
  if (m === 'full' || m === 'full-access') return 'full-access';
  return m;
}

function fail(code, status = 400, message = code) {
  throw new Fault(code, status, { message });
}

function parseLimit(value, fallback = 50, max = 200) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(max, parsed);
}

function asRouteError(error) {
  if (error instanceof Fault) return error;
  const code = error?.code || (error instanceof CommunicationValidationError ? 'COMMUNICATION_INVALID' : error instanceof CommunicationStateError ? 'COMMUNICATION_STATE' : 'INTELLIGENCE_REQUEST_INVALID');
  const status = Number(error?.status) || (code === 'E_BENCHMARK_NOT_FOUND' ? 404 : 400);
  return new Fault(code, status, { message: String(error?.message || code) });
}

export function registerIntelligenceRoutes(app, {
  evaluation = null,
  planner = new AdaptivePlanner(),
  replanner = null,
  capabilityRegistry = null,
  teamOptimizer = null,
  communication = null,
  memory = null,
  directAgent = null,
} = {}) {
  const effectiveReplanner = replanner ?? new AdaptiveReplanner({ planner });

  app.get('/v1/benchmarks', async () => {
    if (!evaluation) return { items: [] };
    return { items: evaluation.listBenchmarks() };
  });

  app.get('/v1/evaluations', async (req) => {
    if (!evaluation) return { items: [] };
    return { items: evaluation.listRuns({ benchmarkId: req.query?.benchmarkId ?? null, limit: parseLimit(req.query?.limit) }) };
  });

  app.get('/v1/evaluations/regression', async (req) => {
    if (!evaluation) return { passed: false, regressions: ['evaluation_unavailable'] };
    const benchmarkId = String(req.query?.benchmarkId || '');
    if (!benchmarkId) fail('BENCHMARK_ID_REQUIRED');
    const runs = evaluation.listRuns({ benchmarkId, limit: 200 });
    const baseline = req.query?.baselineRunId ? evaluation.getRun(String(req.query.baselineRunId)) : runs.at(1);
    const candidate = req.query?.candidateRunId ? evaluation.getRun(String(req.query.candidateRunId)) : runs.at(0);
    if (!baseline || !candidate) fail('EVALUATION_RUN_REQUIRED', 404, 'baseline and candidate runs are required');
    const comparable = [baseline, candidate].every((run) =>
      run.benchmarkId === benchmarkId &&
      run.benchmarkVersion === candidate.benchmarkVersion &&
      run.datasetVersion === candidate.datasetVersion &&
      run.status === 'completed' &&
      run.score,
    );
    if (!comparable) fail('EVALUATION_RUN_NOT_COMPARABLE', 409, 'baseline and candidate must be completed runs from the same benchmark and dataset version');
    const { compareRegression } = await import('../evaluation/regression.js');
    return {
      benchmarkId,
      baselineRunId: baseline.id,
      candidateRunId: candidate.id,
      baseline: baseline.score ?? null,
      candidate: candidate.score ?? null,
      ...compareRegression(baseline, candidate),
    };
  });

  app.post('/v1/evaluations', async (req) => {
    if (!evaluation) fail('EVALUATION_UNAVAILABLE', 503);
    try { return { run: evaluation.start(req.body ?? {}) }; } catch (error) { throw asRouteError(error); }
  });

  app.get('/v1/evaluations/:id', async (req, reply) => {
    if (!evaluation) return reply.code(503).send({ error: { code: 'EVALUATION_UNAVAILABLE' } });
    try { return evaluation.getRun(req.params.id); } catch (error) { throw asRouteError(error); }
  });

  app.post('/v1/evaluations/:id/cancel', async (req) => {
    if (!evaluation) fail('EVALUATION_UNAVAILABLE', 503);
    try { return evaluation.cancel(req.params.id); } catch (error) { throw asRouteError(error); }
  });

  app.post('/v1/plans', async (req) => {
    try { return planner.createPlan(req.body ?? {}); } catch (error) { throw asRouteError(error); }
  });
  app.post('/v1/plans/validate', async (req) => {
    try { return planner.validate(req.body?.plan ?? req.body ?? {}); } catch (error) { throw asRouteError(error); }
  });
  app.post('/v1/autonomous/runs', async (req, reply) => {
    if (!directAgent?.submitAutonomousGoal) fail('SWARM_UNAVAILABLE', 503);
    try {
      const body = req.body ?? {};
      const goal = String(body.goal ?? '').trim();
      if (!goal) fail('EMPTY_GOAL', 400, 'Autonomous goal is required');
      if (body.sessionId && body.workspaceRoot) {
        const session = directAgent.getSession(String(body.sessionId));
        if (session?.workspaceRoot && !sameWorkspacePath(body.workspaceRoot, session.workspaceRoot)) {
          fail('WORKSPACE_MISMATCH', 403, 'Requested workspaceRoot does not match session workspaceRoot');
        }
      }
      const traffic = classifyTrafficSource(req.headers);
      const wait = body.wait === true || req.query?.wait === 'true';
      const result = await directAgent.submitAutonomousGoal({
        goal,
        sessionId: body.sessionId ?? null,
        workspaceRoot: body.workspaceRoot ?? null,
        permissionMode: body.permissionMode ?? null,
        maxConcurrency: body.maxConcurrency ?? 3,
        budget: body.budget ?? {},
        maxReplans: body.maxReplans ?? 2,
        maxNodes: body.maxNodes ?? 6,
        workspaceSummary: body.workspaceSummary ?? '',
        wait,
        trafficSource: traffic.trafficSource,
        isSynthetic: traffic.isSynthetic ? 1 : 0,
      });
      return reply.code(wait ? 201 : 202).send(result);
    } catch (error) { throw asRouteError(error); }
  });
  app.post('/v1/plans/execute', async (req, reply) => {
    if (!directAgent?.submitPlannedSwarmRun) fail('SWARM_UNAVAILABLE', 503);
    try {
      const body = req.body ?? {};
      if (!body.plan && !Array.isArray(body.tasks) && body.goal && directAgent?.submitAutonomousGoal) {
        const traffic = classifyTrafficSource(req.headers);
        const wait = body.wait === true || req.query?.wait === 'true';
        const result = await directAgent.submitAutonomousGoal({
          goal: body.goal,
          sessionId: body.sessionId ?? null,
          workspaceRoot: body.workspaceRoot ?? null,
          permissionMode: body.permissionMode ?? null,
          maxConcurrency: body.maxConcurrency ?? 3,
          budget: body.budget ?? {},
          maxReplans: body.maxReplans ?? 2,
          wait,
          trafficSource: traffic.trafficSource,
          isSynthetic: traffic.isSynthetic ? 1 : 0,
        });
        return reply.code(wait ? 201 : 202).send(result);
      }
      const plan = planner.validate(body.plan ?? body);
      const session = body.sessionId
        ? directAgent.getSession(String(body.sessionId))
        : directAgent.createSession({
            title: `[Swarm Plan] ${String(plan.goal ?? '').slice(0, 60)}`,
            workspaceRoot: body.workspaceRoot ?? null,
            permissionMode: normalizeSessionPermissionMode(body.permissionMode ?? plan.permissionMode ?? 'auto-safe'),
          });
      if (body.sessionId && body.workspaceRoot && session?.workspaceRoot && !sameWorkspacePath(body.workspaceRoot, session.workspaceRoot)) {
        fail('WORKSPACE_MISMATCH', 403, 'Requested workspaceRoot does not match session workspaceRoot');
      }
      const parentPermissionMode = body.permissionMode
        ? intersectPolicies(
            { permissionMode: session.permissionMode || 'auto-safe' },
            { permissionMode: String(body.permissionMode) },
          ).permissionMode
        : session.permissionMode || plan.permissionMode || 'auto-safe';
      const traffic = classifyTrafficSource(req.headers);
      const result = directAgent.submitPlannedSwarmRun({
        plan,
        sessionId: session.id,
        rootTurnId: body.rootTurnId ?? null,
        workspaceRoot: session.workspaceRoot || body.workspaceRoot || directAgent.getWorkspaceRoot?.(),
        parentPermissionMode,
        maxConcurrency: body.maxConcurrency ?? 3,
        budget: body.budget ?? plan.budget,
        maxReplans: body.maxReplans ?? 2,
        trafficSource: traffic.trafficSource,
        isSynthetic: traffic.isSynthetic ? 1 : 0,
      });
      return reply.code(202).send(result);
    } catch (error) { throw asRouteError(error); }
  });
  app.post('/v1/plans/replan', async (req) => {
    try {
      return effectiveReplanner.replan(
        req.body?.currentPlan ?? req.body?.plan,
        req.body?.proposal ?? {},
        {
          completedTaskKeys: req.body?.completedTaskKeys ?? [],
          appliedEffectKeys: req.body?.appliedEffectKeys ?? [],
        },
      );
    } catch (error) { throw asRouteError(error); }
  });

  app.get('/v1/agents/capabilities', async () => ({ items: capabilityRegistry?.snapshot?.() ?? [] }));
  app.post('/v1/agents/capabilities', async (req) => {
    if (!capabilityRegistry) fail('CAPABILITY_REGISTRY_UNAVAILABLE', 503);
    try { return capabilityRegistry.registerDeclared(req.body ?? {}); } catch (error) { throw asRouteError(error); }
  });
  app.post('/v1/agents/capabilities/measure', async () => {
    // Measured capability is evidence-backed state. Ordinary HTTP clients cannot write it.
    fail('CAPABILITY_MEASUREMENT_FORBIDDEN', 403, 'Measured capabilities can only be recorded by the trusted evaluation service');
  });

  app.post('/v1/swarm/teams/optimize', async (req) => {
    if (!teamOptimizer) fail('TEAM_OPTIMIZER_UNAVAILABLE', 503);
    try { return teamOptimizer.optimize(req.body ?? {}); } catch (error) { throw asRouteError(error); }
  });

  app.post('/v1/communication/messages', async (req) => {
    if (!communication) fail('COMMUNICATION_UNAVAILABLE', 503);
    try { return await communication.send(req.body ?? {}); } catch (error) { throw asRouteError(error); }
  });
  app.get('/v1/communication/messages', async (req) => {
    if (!communication) return { items: [] };
    try { return { items: await communication.list({ conversationId: req.query?.conversationId ?? null, runId: req.query?.runId ?? null, status: req.query?.status ?? null }) }; } catch (error) { throw asRouteError(error); }
  });
  app.post('/v1/communication/messages/receive', async (req) => {
    if (!communication) fail('COMMUNICATION_UNAVAILABLE', 503);
    try { return { message: await communication.receive(String(req.body?.agentId || ''), req.body?.options ?? {}) }; } catch (error) { throw asRouteError(error); }
  });
  app.post('/v1/communication/messages/:id/ack', async (req) => {
    if (!communication) fail('COMMUNICATION_UNAVAILABLE', 503);
    try { return await communication.ack(req.params.id, String(req.body?.agentId || ''), req.body?.deliveryToken); } catch (error) { throw asRouteError(error); }
  });

  app.get('/v1/memory/experience', async (req) => {
    if (!memory) return { items: [] };
    try {
      const projectId = String(req.query?.projectId || '').trim();
      if (!projectId) fail('PROJECT_ID_REQUIRED', 400, 'projectId is required');
      return memory.retrieve({ projectId, query: String(req.query?.query || ''), limit: parseLimit(req.query?.limit, 20, 100), tokenBudget: Number(req.query?.tokenBudget || 4000) });
    } catch (error) { throw asRouteError(error); }
  });
  app.post('/v1/memory/experience', async (req) => {
    if (!memory) fail('EXPERIENCE_MEMORY_UNAVAILABLE', 503);
    try {
      const body = req.body ?? {};
      const input = body.candidates ?? body.content ?? body;
      return memory.remember(input, { projectId: body.projectId, source: 'api' });
    } catch (error) { throw asRouteError(error); }
  });
  app.post('/v1/memory/experience/:id/feedback', async (req) => {
    if (!memory) fail('EXPERIENCE_MEMORY_UNAVAILABLE', 503);
    try {
      const body = req.body ?? {};
      if (body.action === 'verify') fail('MEMORY_VERIFICATION_FORBIDDEN', 403, 'use trusted server-side verification evidence');
      if (body.verified === true) fail('MEMORY_VERIFICATION_FORBIDDEN', 403, 'verified memory can only be created by trusted server-side verification');
      return memory.feedback({ id: req.params.id, ...body });
    } catch (error) { throw asRouteError(error); }
  });
  app.delete('/v1/memory/experience/:id', async (req) => {
    if (!memory) fail('EXPERIENCE_MEMORY_UNAVAILABLE', 503);
    try { return memory.remove({ id: req.params.id, projectId: req.query?.projectId || req.body?.projectId }); } catch (error) { throw asRouteError(error); }
  });
}


