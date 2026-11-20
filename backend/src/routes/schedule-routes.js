export function registerScheduleRoutes(app, { scheduler }) {
  app.get('/v1/schedules', async () => ({
    items: scheduler ? scheduler.list() : [],
  }));

  app.post('/v1/schedules', async (req, reply) => {
    if (!scheduler) {
      return reply.code(503).send({
        error: { code: 'SCHEDULER_UNAVAILABLE', message: 'Scheduler unavailable', status: 503 },
      });
    }
    const created = scheduler.create(req.body ?? {});
    return reply.code(201).send(created);
  });

  app.patch('/v1/schedules/:id', async (req) => scheduler.update(req.params.id, req.body ?? {}));

  app.delete('/v1/schedules/:id', async (req) => scheduler.delete(req.params.id));

  app.post('/v1/schedules/:id/run', async (req) => scheduler.runNow(req.params.id));
}
