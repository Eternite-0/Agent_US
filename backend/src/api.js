import { publicRoutes } from './routes.js';
import { v1Routes } from './v1-routes.js';
import { decide, filemap } from './tools.js';
import Fastify from 'fastify';
import { z, ZodError } from 'zod';
import { timingSafeEqual, createHash } from 'node:crypto';
import { Fault } from './store.js';
export const uuid = z.uuid();
const digest = (s) => createHash('sha256').update(s).digest();
export function api(
  store,
  token,
  providers = { models: [], list: () => [] },
  {
    snapshotPin = null,
    pool = null,
    directAgent = null,
    checkin = null,
    webLogin = null,
    controlPlane = null,
  } = {},
) {
  if (!token || token.length < 24)
    throw Error('BACKEND_TOKEN requires at least 24 characters');
  const app = Fastify({ bodyLimit: 512 * 1024, logger: false });
  app.addHook('onRequest', async (req) => {
    const pathname = req.url.split('?')[0];
    if (
      pathname === '/health' ||
      pathname === '/v1/health' ||
      pathname === '/v1/auth/oauth/callback'
    )
      return;
    const authHeader = String(req.headers.authorization ?? '');
    const xApiKey = String(req.headers['x-api-key'] ?? '');
    const bearerOk = timingSafeEqual(
      digest(authHeader),
      digest(`Bearer ${token}`),
    );
    const apiKeyOk =
      Boolean(xApiKey) &&
      pathname.startsWith('/v1/') &&
      timingSafeEqual(digest(xApiKey), digest(token));
    if (!bearerOk && !apiKeyOk) throw new Fault('UNAUTHORIZED', 401);
  });
  app.setErrorHandler((e, req, rep) => {
    const status =
      e instanceof Fault
        ? e.status
        : e instanceof ZodError
          ? 400
          : (e.statusCode ?? 500);
    const message =
      e instanceof Fault && e.detail && typeof e.detail.message === 'string'
        ? e.detail.message
        : undefined;
    rep.code(status).send({
      error: {
        code:
          e instanceof Fault
            ? e.code
            : status < 500
              ? 'INVALID_REQUEST'
              : 'INTERNAL_ERROR',
        ...(message ? { message } : {}),
        requestId: req.id,
      },
    });
  });
  app.get('/health', async () => ({
    ok: store.db.prepare('SELECT 1 AS ok').get().ok === 1,
  }));
  app.post('/api/v1/projects', async (req) =>
    store.add(
      'projects',
      z
        .strictObject({ name: z.string().trim().min(1).max(180) })
        .parse(req.body),
    ),
  );
  app.post('/api/v1/tasks', async (req) => {
    const body = z
      .strictObject({
        projectId: uuid,
        input: z.string().trim().min(1).max(16000),
        idempotencyKey: z.string().min(1).max(128),
        files: filemap
          .refine(
            (f) =>
              Object.keys(f).length <= 64 &&
              JSON.stringify(f).length <= 345000,
          )
          .optional(),
        budget: z
          .strictObject({
            maxSteps: z.number().int().min(1).max(32).optional(),
            maxDurationSeconds: z.number().int().min(10).max(7200).optional(),
            maxCostUSD: z.number().positive().max(100).optional(),
          })
          .optional(),
        approvalMode: z
          .enum(['manual', 'workspace-write', 'auto-review'])
          .optional(),
      })
      .parse(req.body);
    const pin = snapshotPin ? await snapshotPin(body) : undefined;
    return store.submit({ ...body, ...(pin ? { pin } : {}) });
  });
  for (const kind of [
    'projects',
    'tasks',
    'assignments',
    'workers',
    'sessions',
    'artifacts',
    'evidence',
    'approvals',
    'memory',
    'usage',
  ]) {
    app.get(`/api/v1/${kind}/:id`, async (req) =>
      store.get(kind, uuid.parse(req.params.id)),
    );
    app.get(`/api/v1/${kind}`, async (req) =>
      store.list(
        kind,
        z
          .strictObject({
            taskId: uuid.optional(),
            projectId: uuid.optional(),
            limit: z.coerce.number().int().min(1).max(200).optional(),
            offset: z.coerce.number().int().min(0).optional(),
          })
          .parse(req.query),
      ),
    );
  }
  app.post('/api/v1/approvals/:id/decision', async (req) =>
    decide(
      store,
      uuid.parse(req.params.id),
      z
        .strictObject({
          version: z.number().int().positive(),
          decision: z.enum(['approve', 'deny']),
          outcome: z.enum(['succeeded', 'not_applied', 'abort']).optional(),
          reason: z.string().max(500).optional(),
        })
        .parse(req.body),
    ),
  );
  app.patch('/api/v1/projects/:id', async (req) => {
    const p = store.get('projects', uuid.parse(req.params.id));
    const b = z
      .strictObject({
        name: z.string().trim().min(1).max(180),
        version: z.number().int().positive(),
      })
      .parse(req.body);
    if (p.version !== b.version) throw new Fault('STALE_VERSION');
    return store.update('projects', p, { name: b.name });
  });
  app.get('/api/v1/tasks/:id/versions/:version', async (req) => {
    const t = store.get('tasks', uuid.parse(req.params.id));
    const version = z.coerce
      .number()
      .int()
      .positive()
      .parse(req.params.version);
    if (version === t.version) return t;
    const r = store.db
      .prepare('SELECT body FROM revisions WHERE id=? AND version=?')
      .get(t.id, version);
    if (!r) throw new Fault('NOT_FOUND', 404);
    return {
      ...JSON.parse(r.body),
      id: t.id,
      version,
      projectId: t.projectId,
      taskId: null,
    };
  });
  publicRoutes(app, store, providers);
  v1Routes(app, { store, providers, pool, directAgent, checkin, webLogin, controlPlane });
  return app;
}
