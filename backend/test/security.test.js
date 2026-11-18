import test from 'node:test';import assert from 'node:assert/strict';import {setTimeout as delay} from 'node:timers/promises';
import {sandbox,toolset,decide} from '../src/tools.js';import {Store,id} from '../src/store.js';
test('real Codex command inside Docker enforces user, network, read-only root and returns files',async()=>{
 const r=await sandbox(['sh','-c','test "$(id -u)" = 65534 && test ! -e /sys/class/net/eth0 && ! touch /etc/forbidden && printf done > proof'],{});
 assert.equal(r.exitCode,0);assert.equal(Buffer.from(r.files.proof,'base64').toString(),'done');
});
test('approval binds one attempt, denied calls never start, then approved diff is persisted',async t=>{
 const store=new Store(':memory:');t.after(()=>store.close());const p=store.add('projects',{name:'approval'});let task=store.submit({projectId:p.id,input:'x',idempotencyKey:'1'});task=store.update('tasks',task,{status:'running'});
 const row=store.db.prepare('SELECT * FROM jobs').get();store.db.prepare("UPDATE jobs SET status='active',fence='f',expires=?").run(Date.now()+120000);
 const ctx={store,task,worker:{id:id()},node:{id:id(),role:'Coder',dependencies:[]},job:{...row,fence:'f'},signal:AbortSignal.timeout(40000),guard:()=>{}};
 const tool=toolset(ctx).find(t=>t.name==='write_file');for(const choice of ['deny','approve']){
 const pending=tool.execute({path:'result.txt',text:'approved'},{signal:ctx.signal,callId:id()});await delay(10);
 const a=store.list('approvals').at(-1);assert.equal(store.list('evidence').length,0);decide(store,a.id,{version:1,decision:choice});assert.throws(()=>decide(store,a.id,{version:1,decision:choice}));
 if(choice==='deny')await assert.rejects(pending,/APPROVAL_DENIED/);else assert.equal(JSON.parse(await pending).exitCode,0);}
 assert.equal(store.list('evidence')[0].changes[0].path,'result.txt');
});
