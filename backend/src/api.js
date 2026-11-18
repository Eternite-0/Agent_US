import {decide} from './tools.js';
import Fastify from 'fastify';
import {z,ZodError} from 'zod';
import {timingSafeEqual,createHash} from 'node:crypto';
import {Fault} from './store.js';
export const uuid=z.uuid();
const digest=s=>createHash('sha256').update(s).digest();
export function api(store, token) {
  if(!token || token.length<24) throw Error('BACKEND_TOKEN requires at least 24 characters');
  const app=Fastify({bodyLimit:128*1024,logger:false});
  app.addHook('onRequest',async req=>{
    if(req.url==='/health') return;
    if(!timingSafeEqual(digest(req.headers.authorization ?? ''),digest(`Bearer ${token}`))) throw new Fault('UNAUTHORIZED',401);
  });
  app.setErrorHandler((e,req,rep)=>{ const status=e instanceof Fault?e.status:e instanceof ZodError?400:e.statusCode??500;
    rep.code(status).send({error:{code:e instanceof Fault?e.code:status<500?'INVALID_REQUEST':'INTERNAL_ERROR',requestId:req.id}}); });
  app.get('/health',async()=>({ok:store.db.prepare('SELECT 1 AS ok').get().ok===1}));
  app.post('/api/v1/projects',async req=>store.add('projects',z.strictObject({name:z.string().trim().min(1).max(180)}).parse(req.body)));
  app.post('/api/v1/tasks',async req=>store.submit(z.strictObject({projectId:uuid,input:z.string().trim().min(1).max(16000),idempotencyKey:z.string().min(1).max(128)}).parse(req.body)));
  for(const kind of ['projects','tasks','assignments','workers','sessions','artifacts','evidence','approvals']) {
    app.get(`/api/v1/${kind}/:id`,async req=>store.get(kind,uuid.parse(req.params.id)));
    app.get(`/api/v1/${kind}`,async req=>store.list(kind,z.strictObject({taskId:uuid.optional(),projectId:uuid.optional(),limit:z.coerce.number().int().min(1).max(200).optional(),offset:z.coerce.number().int().min(0).optional()}).parse(req.query)));
  }
  app.post('/api/v1/approvals/:id/decision',async req=>decide(store,uuid.parse(req.params.id),z.strictObject({version:z.number().int().positive(),decision:z.enum(['approve','deny'])}).parse(req.body)));
  return app;
}

