import { Fault } from '../store.js';

export function registerScheduleRoutes(app, { scheduler }) {
  const requireScheduler = () => {
    if (!scheduler) {
      throw new Fault('SCHEDULER_UNAVAILABLE', 503, { message: 'Scheduler unavailable' });
    }
    return scheduler;
  };

  app.get('/v1/schedules', async () => ({
    items: scheduler ? scheduler.list() : [],
  }));

  app.get('/v1/schedules/:id', async (req) => requireScheduler().get(req.params.id));

  app.post('/v1/schedules', async (req, reply) => {
    const created = requireScheduler().create(req.body ?? {});
    return reply.code(201).send(created);
  });

  app.patch('/v1/schedules/:id', async (req) =>
    requireScheduler().update(req.params.id, req.body ?? {}),
  );

  app.delete('/v1/schedules/:id', async (req) => requireScheduler().delete(req.params.id));

  app.post('/v1/schedules/:id/run', async (req) => requireScheduler().runNow(req.params.id));

  app.get('/v1/schedules/:id/runs', async (req) => ({
    items: requireScheduler().listRuns(req.params.id, { limit: Number(req.query?.limit ?? 50) }),
  }));

  app.post('/v1/schedules/:id/runs/:runId/cancel', async (req) =>
    requireScheduler().cancelRun(req.params.id, req.params.runId),
  );
}
