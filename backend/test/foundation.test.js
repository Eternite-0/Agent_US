import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.js';
import {api} from '../src/api.js';
import {bundle} from '../src/bundle.js';
test('Cordis bundle, REST auth, atomic submission, idempotence and optimistic concurrency',async t=>{
 const db=new Store(':memory:'); const ctx=await bundle(db); const token='a'.repeat(32); const app=api(ctx.taskEngine,token);
 t.after(async()=>{await app.close();await ctx.fiber.dispose();db.close()});
 assert.equal((await app.inject('/health')).json().ok,true);
 assert.equal((await app.inject('/api/v1/projects')).statusCode,401);
 const post=(url,payload)=>app.inject({method:'POST',url:'/api/v1/'+url,headers:{authorization:`Bearer ${token}`},payload});
 const p=(await post('projects',{name:'P'})).json(); const payload={projectId:p.id,input:'do work',idempotencyKey:'123'};
 const task=(await post('tasks',payload)).json(); assert.equal(task.status,'planning');assert.equal((await post('tasks',payload)).json().id,task.id);
 assert.equal(db.db.prepare('SELECT count(*) AS n FROM jobs').get().n,1);
 assert.throws(()=>db.tx(()=>{db.update('tasks',task,{status:'invalid'});throw Error('rollback')})); assert.equal(db.get('tasks',task.id).version,1);
 db.update('tasks',task,{status:'running'}); assert.throws(()=>db.update('tasks',task,{}),/STALE_VERSION/);
 assert.equal((await post('tasks',{...payload,input:'changed'})).statusCode,409);
});
