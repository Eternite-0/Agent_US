// Rebuild the 2.3.7 report tables from either the five lanes or the published gzip.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { tasks as original, fixtureDigest, workspaceFiles } from './fixtures/real-model-tasks.mjs';
import { capabilityTasks } from './fixtures/capability-tasks.mjs';

const tasks=[...original,...capabilityTasks];
const revisions={before:'3ea6b57c6d2889c775d3ccda28d2f165e7300682',after:'1672ea151703f04aa7c6bfcf7273ea1ad5d5b028'};
const rows=process.argv.slice(2).flatMap(file=>{
  const bytes=readFileSync(file);
  return (file.endsWith('.gz')?gunzipSync(bytes):bytes).toString('utf8').trim().split('\n').filter(Boolean).map(s=>JSON.parse(s));
});
const m=new Map(rows.map(r=>[`${r.task}/${r.rep}/${r.arm}`,r]));
assert.equal(rows.length,14*5*2,'need all 140 formal runs');assert.equal(m.size,rows.length,'duplicate run');
const pairs=tasks.flatMap((t,i)=>Array.from({length:5},(_,rep)=>{
  const p={t,rep};
  for(const [pos,arm] of ((rep+i)%2?['after','before']:['before','after']).entries()){
    const r=m.get(`${t.id}/${rep}/${arm}`);assert.ok(r);p[arm]=r;
    assert.equal(r.position,pos);assert.equal(r.lane,i%5);
    if(r.infra) continue; // included in scheduled denominator; no pseudo tool measurements
    assert.equal(r.revision,revisions[arm]);assert.equal(r.permission,'approval');assert.equal(r.deadlineMs,110000);
    assert.deepEqual(r.budget,{maxSteps:10,maxOutputTokens:4096,maxTotalTokens:110000});
    assert.equal(r.fixtureDigest,fixtureDigest(t));assert.equal(r.requestedModel,'cn:deepseek-v4.1-flash');
    for(const model of r.wireModels)assert.equal(model,'deepseek-v4.1-flash');
  }
  if(!p.before.infra&&!p.after.infra)assert.equal(p.before.fixtureCommit,p.after.fixtureCommit);
  return p;
}));
const count=(xs,fn)=>xs.filter(fn).length;
const median=xs=>{const a=xs.filter(Number.isFinite).sort((a,b)=>a-b);return a.length?(a[(a.length-1)>>1]+a[a.length>>1])/2:null;};
const denied=c=>c.name==='bash' && c.status==='rejected_before_effect' && ['APPROVAL_DENIED','POLICY_DENIED'].includes(c.errorCode);
const known=r=>!r.infra && r.wireModels?.length===1;
const healthy=r=>known(r)&&!r.timedOut&&r.wire.length>0&&r.wire.every(w=>w.http===200&&w.done);
const taskById=new Map(tasks.map(t=>[t.id,t]));
function first(r){const t=taskById.get(r.task);const initial=workspaceFiles(t);const times=r.calls.filter(c=>c.fit&&!c.noMatch&&
  (c.name!=='read_file'||Object.hasOwn(initial,String(c.args?.path??'').replaceAll('\\','/').replace(/^\.\//,'')))&&!['update_plan','read_blob'].includes(c.name)&&
  (c.status==='finished'||t.initialFailure&&c.name==='bash'&&c.exitCode===1)).map(c=>c.resultAtMs).filter(Number.isFinite);return times.length?Math.min(...times):null;}
function metrics(xs){
  const recorded=xs.filter(r=>!r.infra), calls=recorded.flatMap(r=>r.calls), wire=recorded.flatMap(r=>r.wire);
  const usage=recorded.filter(r=>r.usage.successful>0&&r.usage.successful===r.usage.withUsage).map(r=>r.usage.inputTokens+r.usage.outputTokens);
  const firstMs=recorded.map(first).filter(Number.isFinite), sums=(key)=>recorded.reduce((n,r)=>n+r[key],0);
  const hist=arr=>Object.fromEntries([...new Set(arr)].sort().map(k=>[k,count(arr,x=>x===k)]));
  return {n:xs.length,infra:xs.length-recorded.length,strict:count(xs,r=>r.pass),artifact:count(xs,r=>r.independent),ordered:count(recorded,r=>Object.values(r.order).every(Boolean)),
    calls:calls.length,fit:count(calls,c=>c.fit),firstCallFit:count(recorded,r=>r.calls[0]?.fit===true),invalid:sums('invalid'),repeat:sums('repeats'),noMatch:count(calls,c=>c.noMatch),
    bash:count(calls,c=>c.name==='bash'),bashDenied:count(calls,denied),bashDenialCodes:hist(calls.filter(denied).map(c=>c.errorCode)),
    bashShownTrials:count(recorded,r=>r.wire.some(w=>w.tools.includes('bash'))),anyBashDenial:count(recorded,r=>r.calls.some(denied)),
    usefulFirstMs:median(firstMs),usefulFirstObserved:firstMs.length,wallMs:median(recorded.map(r=>r.wallMs)),
    tokenMedian:median(usage),tokenCoverage:usage.length,totalMeteredTokens:usage.reduce((a,b)=>a+b,0),firstWireInput:median(recorded.map(r=>r.wire[0]?.usage?.in)),
    http:hist(wire.map(w=>String(w.http??w.transport??'unknown'))),done:count(wire,w=>w.done),healthyTrials:count(xs,healthy),knownModelTrials:count(xs,known),timeouts:count(recorded,r=>r.timedOut),
    unauthorizedChanges:recorded.reduce((a,r)=>a+r.unauthorizedChanges.length,0),mcpAdvertised:recorded.reduce((a,r)=>a+(r.mcp?.advertised.length??0),0),mcpExpected:recorded.reduce((a,r)=>a+(r.mcp?.expected.length??0),0)};
}
function diff(pairs,fn){
  const blocks=new Map();let observed=0;
  for(const p of pairs){const d=fn(p.after)-fn(p.before);blocks.set(p.t.id,(blocks.get(p.t.id)??0)+d);observed+=d;}
  let extreme=0;const sums=[0];for(const d of blocks.values()) {const a=sums.splice(0);for(const x of a)sums.push(x+d,x-d);}
  for(const n of sums)if(Math.abs(n)>=Math.abs(observed))extreme++;
  return {pairs:pairs.length,tasks:blocks.size,afterMinusBefore:observed,twoSidedP:pairs.length?extreme/sums.length:null};
}
const clean=pairs.filter(p=>healthy(p.before)&&healthy(p.after));
const both=pairs.filter(p=>p.before.pass&&p.after.pass);
const scoped=ps=>Object.fromEntries(Object.keys(revisions).map(arm=>[arm,metrics(ps.map(p=>p[arm]))]));
const denials=r=>r.calls.filter(denied).length;
const tracePairs=pairs.filter(p=>!p.before.infra&&!p.after.infra);
console.log(JSON.stringify({revisions,overall:scoped(pairs),original:scoped(pairs.filter(p=>original.includes(p.t))),newTasks:scoped(pairs.filter(p=>capabilityTasks.includes(p.t))),
 bashAllowed:scoped(pairs.filter(p=>p.t.test)),bashNotAllowed:scoped(pairs.filter(p=>!p.t.test)),healthyPairs:scoped(clean),bothPassed:scoped(both),
 refusalEffect:diff(tracePairs,denials),allowedRefusalEffect:diff(tracePairs.filter(p=>p.t.test),denials),healthyRefusalEffect:diff(clean,denials),successEffect:diff(pairs,r=>Number(Boolean(r.pass))),
 task:pairs.filter(p=>p.rep===0).map(({t})=>({id:t.id,...scoped(pairs.filter(p=>p.t===t))}))},null,2));
