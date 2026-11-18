import {z} from 'zod';
import {readFileSync} from 'node:fs';
import {Model} from './router.js';import {Magpie} from './magpie.js';import {ChatAdapter} from './provider.js';import {unseal} from './vault.js';
const safeEndpoint=z.url().refine(s=>{const u=new URL(s);return !u.username&&!u.password&&!u.search&&!u.hash&&(u.protocol==='https:'||u.protocol==='http:'&&['127.0.0.1','localhost','[::1]','host.docker.internal'].includes(u.hostname));});
const label=z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);
export const Config=z.strictObject({providers:z.array(z.strictObject({id:label,endpoint:safeEndpoint,keyRef:z.string().regex(/^[A-Z][A-Z0-9_]{2,100}$/),sidecarEndpoint:safeEndpoint.optional()})).max(16),models:z.array(Model).max(128),magpie:z.boolean().default(false),mcp:z.record(label,z.array(z.string().max(1024)).min(1).max(32)).default({})}).superRefine((v,c)=>{const ids=new Set(v.providers.map(p=>p.id));if(ids.size!==v.providers.length||v.models.some(m=>!ids.has(m.provider)))c.addIssue({code:'custom',message:'invalid provider registry'});});
export function config(){return Config.parse(process.env.BACKEND_CONFIG?JSON.parse(readFileSync(process.env.BACKEND_CONFIG,'utf8')):{providers:[],models:[]});}
export class Providers {
 constructor(config,store,secrets=process.env.BACKEND_VAULT?unseal(process.env.BACKEND_VAULT):{}){
  this.config=config;this.store=store;this.discovered=new Map();this.routes=new Map();this.enabled=[];
  for(const p of config.providers){const key=secrets[p.keyRef]??process.env[p.keyRef];if(!key)continue;this.enabled.push(p);this.routes.set(p.id,{id:p.id,key,endpoint:p.endpoint});}
  this.models=config.models.filter(m=>this.routes.has(m.provider));
  if(config.magpie)this.sidecar=new Magpie(this.enabled.map(p=>({id:p.id,name:p.id,key:this.routes.get(p.id).key,chat:p.sidecarEndpoint??p.endpoint,listOff:true,models:this.models.filter(m=>m.provider===p.id).map(m=>m.model)})));
  this.adapter=new ChatAdapter((provider,model)=>{const native=this.routes.get(provider);if(!native)return [];const list=[native];if(this.ready&&this.sidecar.base)list.unshift({id:'magpie',key:this.sidecar.token,endpoint:this.sidecar.base+'/v1',wireModel:`${provider}/${model}`});return list;},(type,data)=>store.event(type,null,null,data));
 }
 async refresh(){if(this.refreshing)return this.refreshing;this.refreshing=this.probe().finally(()=>{this.refreshing=null;});return this.refreshing;}
 async probe(){if(this.sidecar){const previous=this.ready;try{await this.sidecar.start();this.ready=true;}catch{this.ready=false;}if(previous!==this.ready)this.store.event('magpie.health',null,null,{ready:this.ready});}
  await Promise.all(this.enabled.map(async p=>{try{const ids=await this.adapter.discover(this.routes.get(p.id));this.discovered.set(p.id,{ok:true,ids:ids.slice(0,2048)});}catch{this.discovered.set(p.id,{ok:false,ids:[]});}}));
 }
 async start(){await this.refresh();this.timer=setInterval(()=>this.refresh().catch(()=>{}),60000);this.timer.unref();}
 async stop(){clearInterval(this.timer);await this.refreshing;await this.sidecar?.stop();}
 list(){return this.config.providers.map(p=>({id:p.id,configured:this.routes.has(p.id),discovery:this.discovered.get(p.id)??null,magpieReady:!!this.ready}));}
}
