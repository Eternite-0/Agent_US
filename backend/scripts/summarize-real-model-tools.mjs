import { readFileSync } from 'node:fs';
import { tasks } from './fixtures/real-model-tasks.mjs';

const sum=(xs,f)=>xs.reduce((n,x)=>n+f(x),0);
const int=(x)=>Number.isInteger(x)&&x>=0;
const p50=(xs)=>{if(!xs.length)return null;const s=[...xs].sort((a,b)=>a-b);return (s[Math.floor((s.length-1)/2)]+s[Math.floor(s.length/2)])/2;};
const fit=(x)=>x!==null&&typeof x==='object';
const expectedRep=5;
const revisions={before:'ef4454748ca7a2e0a6a587390921e3164c2c911d',after:'539e86451f7f2e0feef1e358f9bae38d3f1bf26e'};
const expectedWire='deepseek-v4.1-flash';
const inputs=process.argv.slice(2);
if(!inputs.length)throw new Error('Supply the formal JSONL files, not pilot runs.');
const rows=inputs.flatMap(p=>readFileSync(p,'utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l)));
const group=new Map();
for(const row of rows) {
  if(!tasks.some(t=>t.id===row.task)||!Object.hasOwn(revisions,row.arm)||!int(row.rep)||row.rep>=expectedRep) throw new Error('Unexpected trial key');
  const k=`${row.task}/${row.rep}`;
  const pair=group.get(k)??{};
  if(pair[row.arm])throw new Error(`Duplicate trial ${k}/${row.arm}`);
  pair[row.arm]=row; group.set(k,pair);
}
const full=group.size===tasks.length*expectedRep&&[...group.values()].every(x=>x.before&&x.after);
const comparable=(x)=>x.before&&x.after&&!x.before.infra&&!x.after.infra&&x.before.fixtureCommit===x.after.fixtureCommit&&x.before.fixtureDigest===x.after.fixtureDigest&&
  x.before.revision===revisions.before&&x.after.revision===revisions.after&&x.before.permission==='approval'&&x.after.permission==='approval'&&
  JSON.stringify(x.before.budget)===JSON.stringify(x.after.budget)&&x.before.deadlineMs===x.after.deadlineMs&&x.before.position!==x.after.position&&
  x.before.requestedModel===x.after.requestedModel&&x.before.wireModels?.length===1&&x.after.wireModels?.length===1&&x.before.wireModels[0]===expectedWire&&x.after.wireModels[0]===expectedWire;
const paired=[...group.values()].filter(p=>p.before&&p.after);
const matched=paired.filter(comparable);
const healthy=r=>!r.timedOut && r.wire?.length>0 && r.wire.every(w=>w.http===200&&w.done);
const healthyPairs=matched.filter(p=>healthy(p.before)&&healthy(p.after));
const usageComplete=(r)=>r.usage?.successful>0&&r.usage.successful===r.usage.withUsage;
function stats(sub){
  const trace=sub.filter(r=>!r.infra);
  const mcp=trace.filter(r=>fit(r.mcp));
  const usage=trace.filter(usageComplete);
  const provider=trace.flatMap(r=>r.wire??[]);
  const statuses={};for(const r of provider){const k=r.http??r.transport??'unknown';statuses[k]=(statuses[k]??0)+1;}
  const calls=trace.flatMap(r=>r.calls??[]);
  return {n:sub.length,pass:trace.filter(r=>r.pass).length,independent:trace.filter(r=>r.independent).length,
    infrastructure:sub.filter(r=>r.infra||r.judgeInfra).length,timeOut:trace.filter(r=>r.timedOut).length,
    completed:trace.filter(r=>r.state==='completed').length,orderAll:trace.filter(r=>Object.values(r.order).every(Boolean)).length,
    calls:sum(trace,r=>r.toolCalls),fit:sum(trace,r=>r.selectionFit),invalid:sum(trace,r=>r.invalid),repeats:sum(trace,r=>r.repeats),purposes:calls.filter(c=>Boolean(c.publicPurpose)).length,
    failedAny:trace.filter(r=>r.failedCalls>0).length,recovered:trace.filter(r=>r.failedThenRecovered).length,repairEvents:sum(trace,r=>r.repairEvents),
    mcp:{trials:mcp.length,found:sum(mcp,r=>r.mcp.advertised.length),expected:sum(mcp,r=>r.mcp.expected.length),calls:sum(mcp,r=>r.mcp.calls),reportedSuccess:sum(mcp,r=>r.mcp.reportedSuccess)},
    p50Ms:p50(trace.map(r=>r.wallMs)),providerStatuses:statuses,providerDone:provider.filter(x=>x.done).length,withUsage:provider.filter(x=>int(x.usage?.in)&&int(x.usage?.out)).length,
    ...tokenStats(usage),p50MsPassed:p50(trace.filter(r=>r.pass).map(r=>r.wallMs)),passedTokenStats:tokenStats(usage.filter(r=>r.pass))};
}
function tokenStats(xs){return {coverage:xs.length,p50Input:p50(xs.map(x=>x.usage.inputTokens)),p50Output:p50(xs.map(x=>x.usage.outputTokens)),p50Tokens:p50(xs.map(x=>x.usage.inputTokens+x.usage.outputTokens)),totalInput:xs.length?sum(xs,x=>x.usage.inputTokens):null,totalOutput:xs.length?sum(xs,x=>x.usage.outputTokens):null};}
function pairedEffect(data){
  const counts={beforeOnly:0,afterOnly:0,both:0,neither:0};const blocks=new Map();
  for(const p of data){const b=Number(Boolean(p.before.pass)),a=Number(Boolean(p.after.pass)); counts[b?(a?'both':'beforeOnly'):(a?'afterOnly':'neither')]++;
    const block=blocks.get(p.before.task)??{diff:0,n:0}; block.diff+=a-b;block.n++; blocks.set(p.before.task,block);}
  const values=[...blocks.values()]; const observed=counts.afterOnly-counts.beforeOnly;
  // Clustered exact sign-flip, sharing the sign across repeats of the same task.
  let equalOrMore=0; const combos=2**values.length;
  for(let signs=0;signs<combos;signs++) {
    let delta=0;
    for(const [i,v] of values.entries()) delta+=signs&(1<<i)?v.diff:-v.diff;
    if(Math.abs(delta)>=Math.abs(observed))equalOrMore++;
  }
  // Descriptive percentile interval, resampling entire tasks rather than individual repeats.
  let seed=296736417;const bootstrap=[];
  for(let i=0;values.length&&i<10000;i++) {let diff=0,n=0;for(let j=0;j<values.length;j++){seed=(Math.imul(1664525,seed)+1013904223)>>>0;const v=values[Math.floor(seed/4294967296*values.length)];diff+=v.diff;n+=v.n;}bootstrap.push(diff/n);}
  bootstrap.sort((a,b)=>a-b);
  return {n:data.length,blocks:values.length,...counts,delta:data.length?observed/data.length:null,p:values.length?equalOrMore/combos:null,bootstrap95:bootstrap.length?[bootstrap[249],bootstrap[9749]]:null};
}
const data={completeDesign:full,received:rows.length,paired:paired.length,comparable:matched.length,nonComparable:paired.filter(p=>!comparable(p)).map(p=>`${p.before.task}/${p.before.rep+1}`),
  overall:Object.fromEntries(['before','after'].map(a=>[a,stats(rows.filter(x=>x.arm===a))])),
  effect:{all:pairedEffect(paired),comparable:pairedEffect(matched),commonCatalog:pairedEffect(matched.filter(p=>!p.before.structural)), healthy:pairedEffect(healthyPairs), healthyCommonCatalog:pairedEffect(healthyPairs.filter(p=>!p.before.structural))},
  tasks:tasks.map(t=>({id:t.id,kind:t.kind,structural:Boolean(t.structural),before:stats(rows.filter(x=>x.task===t.id&&x.arm==='before')),after:stats(rows.filter(x=>x.task===t.id&&x.arm==='after'))})),
  passingPairs: Object.fromEntries(['before','after'].map(a=>[a,stats(matched.filter(p=>p.before.pass&&p.after.pass).map(p=>p[a]))])),
};
console.log(JSON.stringify(data,null,2));
if(!full)process.exitCode=2;
