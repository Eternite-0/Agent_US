import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {setTimeout as delay} from 'node:timers/promises';
import {Engine} from '../src/engine.js';import {Store} from '../src/store.js';import {Plan,select} from '../src/router.js';import {model,Script} from './fixtures.js';
export const plan={type:'engineering',complexity:'medium',risk:'low',nodes:['a','b','c'].map((key,i)=>({key,role:'Coder',objective:key,acceptance:'deliver result',dependencies:i===2?['a','b']:[]}))};
test('DSH executes a fork/join plan with distinct workers and audited acceptance',async t=>{
 const root=await mkdtemp(join(tmpdir(),'dsh-dag-'));const store=new Store(join(root,'db'));const project=store.add('projects',{name:'test'});const task=store.submit({projectId:project.id,input:'test',idempotencyKey:'1'});
 let running=0,peak=0,joined=false;const adapter=new Script(async o=>{const payload=JSON.parse(o.messages.at(-1).content[0].text);
 if(payload.criteria)return JSON.stringify({accepted:true,reason:'OK'});if(!payload.assignment)return JSON.stringify(plan);
 peak=Math.max(peak,++running);await delay(80);running--;if(payload.assignment.objective==='c')joined=payload.handoffs.length===2;return 'result';});
 const engine=new Engine({store,root,models:[model],adapter});t.after(async()=>{await engine.stop();store.close()});engine.start();
 for(let i=0;i<120&& !['completed','failed'].includes(store.get('tasks',task.id).status);i++)await delay(50);
 assert.equal(store.get('tasks',task.id).status,'completed');assert.equal(peak,2);assert.ok(joined);assert.equal(store.list('workers').length,5);
});
test('plan rejects cycles and registry enforces tools/context',()=>{assert.throws(()=>Plan.parse({...plan,nodes:[plan.nodes[2]]}));assert.throws(()=>select([{...model,tools:false}],'Coder','simple',100));});
