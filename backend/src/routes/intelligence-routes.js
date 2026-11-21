import { Fault } from '../store.js';
import { validatePlan } from '../planning/validator.js';
import { AdaptivePlanner } from '../planning/planner.js';
import { AdaptiveReplanner } from '../planning/replanner.js';
import { CommunicationValidationError, CommunicationStateError } from '../communication/envelope.js';

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
  app.post('/v1/plans/execute', async (req, reply) => {
    if (!directAgent?.submitPlannedSwarmRun) fail('SWARM_UNAVAILABLE', 503);
    try {
      const plan = planner.validate(req.body?.plan ?? req.body ?? {});
      const result = directAgent.submitPlannedSwarmRun({
        plan,
        sessionId: req.body?.sessionId ?? null,
        rootTurnId: req.body?.rootTurnId ?? null,
        workspaceRoot: req.body?.workspaceRoot ?? null,
        parentPermissionMode: req.body?.permissionMode ?? plan.permissionMode,
        maxConcurrency: req.body?.maxConcurrency ?? 3,
        budget: req.body?.budget ?? plan.budget,
        maxReplans: req.body?.maxReplans ?? 2,
        trafficSource: 'production',
        isSynthetic: 0,
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


