import {mkdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {Store} from './store.js';
import {bundle} from './bundle.js';
import {api} from './api.js';
const root=resolve(process.env.BACKEND_DATA??'var'); mkdirSync(root,{recursive:true,mode:0o700});
const store=new Store(join(root,'engine.sqlite'));
const ctx=await bundle(store);
const app=api(ctx.taskEngine,process.env.BACKEND_TOKEN);
console.log(await app.listen({host:'127.0.0.1',port:Number(process.env.PORT??8787)}));
async function stop(){await app.close(); await ctx.fiber.dispose(); store.close();}
process.once('SIGINT',stop); process.once('SIGTERM',stop);
