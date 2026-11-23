import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { tasks, workspaceFiles, judgeScript, fixtureDigest } from './fixtures/real-model-tasks.mjs';
import { parseCodexPatch } from '../src/patch-and-diagnostics.js';
import { redactSecrets } from '../src/envelope.js';

const BEFORE='ef4454748ca7a2e0a6a587390921e3164c2c911d';
const AFTER='539e86451f7f2e0feef1e358f9bae38d3f1bf26e';
const key=process.env.TI_BENCH_KEY;
delete process.env.TI_BENCH_KEY;
const requestedModel=process.env.TI_BENCH_MODEL ?? 'cn:deepseek-v4.1-flash';
const endpoint=new URL(process.env.TI_BENCH_ENDPOINT ?? 'http://127.0.0.1:7863/v1');
const loopback=['127.0.0.1','[::1]','localhost'].includes(endpoint.hostname);
if (!key || endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
    !(endpoint.protocol==='https:' || loopback && endpoint.protocol==='http:')) throw new Error('Use TI_BENCH_KEY and an authorized HTTPS or loopback endpoint.');
const [baseArg, afterArg, outputArg, laneArg='0', countArg='1', repsArg='5'] = process.argv.slice(2);
if (!baseArg || !afterArg || !outputArg) throw new Error('Usage: benchmark-real-model-tools.mjs BASE_WORKTREE AFTER_WORKTREE OUTPUT.jsonl [lane lanes repeats]');
const lane=Number(laneArg), lanes=Number(countArg), repeats=Number(repsArg);
if (![lane,lanes,repeats].every(Number.isInteger) || lane<0 || lane>=lanes || lanes<1 || lanes>10 || repeats<1 || repeats>20) throw new Error('Invalid lanes or trial count');
const output=resolve(outputArg);
const roots={before:resolve(baseArg),after:resolve(afterArg)};
const shell='node --test test/public.test.mjs';
const tools=['inspect_repository','grep','glob','read_file','edit_file','write_file','apply_patch','bash','update_plan','read_blob'];
const budget={maxSteps:10,maxOutputTokens:4096,maxTotalTokens:110000};
const deadlineMs=110000;
const script=fileURLToPath(new URL('./fixtures/real-model-mcp.mjs',import.meta.url));
const temp=realpathSync(mkdtempSync(join(tmpdir(),'agent-ti236-')));
const ws=join(temp,'freight');
const state=join(temp,'runtime');
const runtimes={};
const exactSecret=(value)=>JSON.stringify(value,(_,v)=>typeof v==='string'?redactSecrets(v.split(key).join('[REDACTED]')):v);
const out=(row)=>appendFileSync(output,exactSecret(row)+'\n',{mode:0o600});
const sha=(x)=>createHash('sha256').update(x).digest('hex');
const originalFetch=globalThis.fetch;
let current;
function readStreamMetadata(text) {
  const models=new Set(); let usage=null, done=false;
  for(const line of text.split('\n')) {
    if(!line.startsWith('data:')) continue;
    const payload=line.slice(5).trim(); if(payload==='[DONE]'){done=true;continue;}
    try { const msg=JSON.parse(payload); if(msg.model)models.add(msg.model); if(msg.usage) usage={in:msg.usage.prompt_tokens,out:msg.usage.completion_tokens}; } catch { /* a non-JSON event isn't usage */ }
  }
  return {models:[...models],usage,done};
}
globalThis.fetch=async (input,init)=>{
  const target=new URL(typeof input==='string'||input instanceof URL?input:input.url);
  if(!current || target.origin!==endpoint.origin || !target.pathname.endsWith('/chat/completions')) return originalFetch(input,init);
  const record={http:null,ms:null,models:[],usage:null,done:false,tools:[]}; const started=performance.now(); const active=current;
  try { record.tools=JSON.parse(init?.body??'{}').tools?.map(t=>t.function?.name).filter(Boolean)??[]; } catch { /* parsed catalog optional */ }
  active.records.push(record);
  try {
    const res=await originalFetch(input,init); record.http=res.status;
    if(!res.ok) {record.ms=Math.round(performance.now()-started);return res;}
    active.pending.push(res.clone().text().then(text=>Object.assign(record,readStreamMetadata(text))).catch(()=>{}).finally(()=>{record.ms=Math.round(performance.now()-started);}));
    return res;
  } catch (err) {record.transport=err.name;record.ms=Math.round(performance.now()-started);throw err;}
};

function git(cwd,...args){
  const res=spawnSync('git',args,{cwd,encoding:'utf8',env:{...process.env,GIT_AUTHOR_DATE:'2024-01-01T00:00:00Z',GIT_COMMITTER_DATE:'2024-01-01T00:00:00Z',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null'}});
  if(res.status!==0) throw new Error(`git ${args[0]} failed`);
  return res.stdout.trimEnd();
}
function seed(t){
  rmSync(ws,{recursive:true,force:true}); mkdirSync(ws);
  for(const [p,text] of Object.entries(workspaceFiles(t))) { const pth=join(ws,p); mkdirSync(dirname(pth),{recursive:true}); writeFileSync(pth,text); }
  git(ws,'init','-q','--initial-branch=main'); git(ws,'add','--all'); git(ws,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','Freeze engineering task'); return git(ws,'rev-parse','HEAD');
}
function snapshot(root,rel=''){
  const state={};
  for(const ent of readdirSync(join(root,rel),{withFileTypes:true})) {
    if(!rel && ent.name==='.git')continue;
    const p=rel?`${rel}/${ent.name}`:ent.name;
    if(ent.isDirectory())Object.assign(state,snapshot(root,p));
    else state[p]=ent.isFile()?sha(readFileSync(join(root,p))):'non-regular-file';
  }
  return state;
}
function changed(a,b){return [...new Set([...Object.keys(a),...Object.keys(b)])].filter(p=>a[p]!==b[p]).sort();}
function parsed(v){try{return typeof v==='string'?JSON.parse(v):v;}catch{return v;}}
function norm(p){return typeof p==='string'?p.replaceAll('\\','/').replace(/^\.\//,''):null;}
function permit(t,name,a){
  const target=(p)=>t.writable.includes(norm(p));
  if(name==='bash')return Boolean(t.test) && [shell,'npm test','npm run test'].includes(a?.command?.trim()) && (!a.cwd || norm(a.cwd)==='.');
  if(name==='edit_file'||name==='write_file')return target(a.path);
  if(name==='apply_patch') {try{return parseCodexPatch(a.patch).every(h=>h.type!=='delete'&&!h.moveTo&&target(h.path));}catch{return false;}}
  if(t.requiredMcp?.includes(name))return true;
  return false;
}
function orderMetrics(t,calls){
  const hasApply=(c)=>!/^(?:outcome_unknown|rejected_before_effect|failed|no_result)$/.test(c.status);
  const write=(c)=>['edit_file','write_file','apply_patch'].includes(c.name);
  const query=(c)=>c.name==='bash'&&permit(t,c.name,c.args);
  const read=(c)=>c.name==='read_file'&&t.inspect.includes(norm(c.args?.path)) || ['grep','inspect_repository'].includes(c.name);
  const firstWrite=calls.findIndex(c=>write(c)&&hasApply(c));
  const lastWrite=calls.findLastIndex(c=>write(c)&&hasApply(c));
  const checks={
    repoBeforeWrite:!t.inspect.length || firstWrite>=0 && calls.slice(0,firstWrite).some(c=>read(c)&&hasApply(c)),
    reproBeforeWrite:!t.initialFailure || firstWrite>=0 && calls.slice(0,firstWrite).some(c=>query(c)&&c.exitCode===1),
    validateAfterWrite:!t.test || lastWrite>=0 && calls.slice(lastWrite+1).some(c=>query(c)&&hasApply(c)&&c.exitCode===0),
    mcpBeforeWrite:!t.requiredMcp || firstWrite>=0 && t.requiredMcp.every((n)=>calls.slice(0,firstWrite).some(c=>c.name===n)),
  };
  return checks;
}
function stable(x) { return x && typeof x==='object' ? Array.isArray(x)?x.map(stable):Object.fromEntries(Object.keys(x).sort().map(k=>[k,stable(x[k])])) : x; }
function checkArgs(t,name,args){
  if(name==='read_file')return [...Object.keys(workspaceFiles(t)),...t.writable].includes(norm(args?.path));
  if(['grep','glob','inspect_repository','update_plan','read_blob'].includes(name))return true;
  if(name==='mcp__inventory__lookup_stock') return t.requiredMcp?.includes(name)&&args?.sku==='M-82';
  if(name.startsWith('mcp__inventory__')) return t.requiredMcp?.includes(name)&&args?.incident===(t.mcp==='log'?'IC-19':'R-31');
  return permit(t,name,args??{});
}
function load(b,s){return import(pathToFileURL(join(roots[b],'backend','src',s)).href);}

async function run(t,arm,rep,position){
  const fixtureCommit=seed(t); const initial=snapshot(ws);
  rmSync(state,{recursive:true,force:true}); mkdirSync(state,{mode:0o700});
  const {Store,AccountPool,DirectAgentRuntime,BenchmarkSandbox,SANDBOX_MODES}=runtimes[arm];
  const sandbox=new BenchmarkSandbox({mode:SANDBOX_MODES.NODE_PERMISSION,workspaceRoot:ws,timeoutMs:8000,cpuLimitSec:2,maxOutputBytes:32000});
  const store=new Store(join(state,'db.sqlite'));
  const pool=new AccountPool(store,{root:state});
  // One eligible route per arm; no shared conversation state or account failover.
  pool.createAccount({preset:'workbuddy',label:'paired benchmark',credential:key,protocol:'openai',endpoint:endpoint.href,models:[requestedModel]});
  pool.setDefaultModel(requestedModel);
  const direct=new DirectAgentRuntime(store,pool,{dataRoot:state,defaultWorkspace:ws,staticMcp:t.mcp?{inventory:[process.execPath,script,t.mcp]}:{}});
  const effects=[]; const events=[]; const wire={records:[],pending:[]}; let unsub;
  let start=performance.now();
  try {
    const permitted=[...tools,...(t.requiredMcp??[])]; if(!t.test)permitted.splice(permitted.indexOf('bash'),1);
    const session=direct.createSession({workspaceRoot:ws,model:requestedModel,permissionMode:'approval',toolAllow:permitted,budget,sandbox,disableWorkspaceHooks:true,disableWorkspaceMcp:!t.mcp,trafficSource:'benchmark',isSynthetic:true});
    let activeWrite=null;
    unsub=direct.subscribe(session.id,evt=>{
      if (['tool/call','tool/result','approval/requested','verifier/repair','verifier/verdict'].includes(evt.type))events.push(evt);
      if (evt.type==='tool/call') {
        const item={id:evt.data.callId,paths:[]}; effects.push(item);
        activeWrite=['edit_file','write_file','apply_patch'].includes(evt.data.name)?item:null;
      } else if(evt.type==='file/changed' && activeWrite) {
        activeWrite.paths.push(evt.data.path);
      } else if(evt.type==='approval/requested') {
        const a=evt.data; const allow=permit(t,a.tool,a.arguments??{});
        queueMicrotask(()=>direct.decideApproval(a.approvalId,{decision:allow?'allow':'deny',scope:'once',reason:'Frozen local benchmark policy'}));
      }
    });
    const prompt=[t.prompt,'Work only inside this repository. Use the available workspace tools. Preserve unrequested files. If you issue tools, you may include a brief public action purpose in the same response (not private reasoning).',t.test?`The approved test command from the repository root is ${shell}.`:''].filter(Boolean).join('\n\n');
    current=wire; start=performance.now();
    const turnId=direct.startTurn(session.id,{input:prompt,model:requestedModel,maxSteps:budget.maxSteps}).turn.id;
    let row;
    do {
      row=direct.listTurns(session.id).find(r=>r.id===turnId);
      if(['completed','failed','cancelled','reconciling'].includes(row?.state))break;
      await delay(50);
    } while(performance.now()-start<deadlineMs);
    const wallMs=Math.round(performance.now()-start);
    const timedOut=!['completed','failed','cancelled','reconciling'].includes(row?.state);
    if(timedOut) { direct.cancelTurn(turnId); for(let i=0;i<50;i++){row=direct.listTurns(session.id).find(r=>r.id===turnId);if(['completed','failed','cancelled','reconciling'].includes(row?.state))break;await delay(50);} }
    await Promise.race([Promise.allSettled(wire.pending),delay(1000,{},{ref:false})]); current=null;
    const calls=[];
    const messages=store.db.prepare("SELECT role,content,toolCalls FROM direct_messages WHERE turnId=? AND role='assistant' ORDER BY seq").all(turnId);
    const receipts=store.db.prepare('SELECT callId,status,exitCode,errorCode,durationMs,outputDigest,approvalId,argsDigest FROM tool_receipts WHERE turnId=? ORDER BY rowid').all(turnId);
    const pick=(type,id)=>events.find(e=>e.type===type&&e.data.callId===id)?.data;
    let step=0;
    for(const m of messages) {
      step++; for(const c of parsed(m.toolCalls)??[]) {
        const a=parsed(c.arguments), rec=receipts.find(r=>r.callId===c.id), result=pick('tool/result',c.id), effect=effects.find(e=>e.id===c.id);
        const actionPurpose=m.content?.trim().slice(0,600)||null;
        calls.push({step,id:c.id,name:c.name,args:a,publicPurpose:actionPurpose,purposeSource:actionPurpose?'same_step_public_assistant_text':'not_emitted',fit:Boolean(checkArgs(t,c.name,a)),
          status:rec?.status??(result?(result.isError?'failed':'finished'):'no_result'),exitCode:rec?.exitCode??null,errorCode:rec?.errorCode??null,durationMs:rec?.durationMs??result?.durationMs??null,
          effect:{writtenPaths:effect?.paths??[],receiptDigest:rec?.outputDigest??null,resultReportedError:result?.isError??null,approved:Boolean(rec?.approvalId)},
          modelVisibleStatus:result?.isError===true?'error':result?.isError===false?'success':'not_observed'});
      }
    }
    const final=snapshot(ws), changedPaths=changed(initial,final), unauthorizedChanges=changedPaths.filter(p=>!t.writable.includes(p));
    // Judge files and tests are outside model context. Use the candidate/common judge
    // implementation for both arms and run with a read-only workspace.
    const Judge=runtimes.after.BenchmarkSandbox;
    let judge, publicJudge;
    try {
      const j=new Judge({mode:runtimes.after.SANDBOX_MODES.NODE_PERMISSION,workspaceRoot:ws,timeoutMs:8000,cpuLimitSec:2,maxOutputBytes:32000});
      judge=await j.runHiddenAcceptance({scriptSource:judgeScript(t)});
      if(t.test)publicJudge=await j.execArgv(['node','--test','test/public.test.mjs'],{workspaceReadOnly:true});
    } catch(err) { judge={passed:false,exitCode:null,infra:err.code??err.name}; }
    const order=orderMetrics(t,calls);
    const seen=new Set(); let repeat=0;
    const epochs={current:0};
    for(const c of calls){if(['edit_file','write_file','apply_patch'].includes(c.name)&&c.status==='finished')epochs.current++;const sig=JSON.stringify([c.name,stable(c.args),epochs.current]);if(seen.has(sig))repeat++;seen.add(sig);}
    const advertised=[...new Set(wire.records.flatMap(r=>r.tools))];
    const failedCalls=calls.filter(c=>c.status==='failed'||c.status==='rejected_before_effect');
    const hidden=judge.passed===true, publicPass=!t.test||publicJudge?.exitCode===0&&!publicJudge?.timedOut;
    const independent=hidden&&publicPass&&unauthorizedChanges.length===0&&t.writable.every(p=>changedPaths.includes(p));
    const passed=independent&&row?.state==='completed'&&!timedOut&&Object.values(order).every(Boolean);
    const artifactDir=join(dirname(output),'artifacts',`${t.id}-${rep}-${arm}`);
    mkdirSync(artifactDir,{recursive:true,mode:0o700});
    for(const p of changedPaths.filter(p=>t.writable.includes(p)&&final[p]&&final[p]!=='non-regular-file')){
      const contents=readFileSync(join(ws,p)); const text=contents.toString('utf8');
      if(contents.length<=64000 && !text.includes(key) && redactSecrets(text)===text){const pth=join(artifactDir,p);mkdirSync(dirname(pth),{recursive:true});writeFileSync(pth,contents,{mode:0o600});}
    }
    const successful=wire.records.filter(r=>r.http===200&&r.done);
    const counted=successful.filter(r=>Number.isFinite(r.usage?.in)&&Number.isFinite(r.usage?.out));
    return {task:t.id,kind:t.kind,completedAt:new Date().toISOString(),structural:Boolean(t.structural),arm,rep,position,lane,revision:arm==='before'?BEFORE:AFTER,fixtureCommit,fixtureDigest:fixtureDigest(t),requestedModel,wireModels:[...new Set(wire.records.flatMap(r=>r.models))],permission:'approval',budget,deadlineMs,wallMs,state:row?.state??null,timedOut,
      pass:passed,independent,hidden,hiddenExit:judge.exitCode??null,judgeInfra:judge.infra??null,publicPass,order,changedPaths,unauthorizedChanges,artifactDirectory:artifactDir,artifactDigests:Object.fromEntries(changedPaths.map(p=>[p,final[p]??null])),
      steps:messages.length,toolCalls:calls.length,selectionFit:calls.filter(c=>c.fit).length,invalid:calls.filter(c=>!c.fit||c.status==='rejected_before_effect'||c.status==='no_result').length,repeats:repeat,failedCalls:failedCalls.length,failedThenRecovered:failedCalls.length>0&&passed,repairEvents:events.filter(x=>x.type==='verifier/repair').length,
      mcp:t.requiredMcp?{expected:t.requiredMcp,advertised:t.requiredMcp.filter(x=>advertised.includes(x)),calls:calls.filter(c=>c.name.startsWith('mcp__')).length,reportedSuccess:calls.filter(c=>c.name.startsWith('mcp__')&&c.status==='finished').length}:null,
      usage:{requests:wire.records.length,successful:successful.length,withUsage:counted.length,inputTokens:counted.length?counted.reduce((a,r)=>a+r.usage.in,0):null,outputTokens:counted.length?counted.reduce((a,r)=>a+r.usage.out,0):null},wire:wire.records,calls };
  } finally { current=null;unsub?.();await direct.close();store.close(); }
}

try {
  for(const arm of ['before','after']) {
    const expected=arm==='before'?BEFORE:AFTER;
    if(git(roots[arm],'rev-parse','HEAD')!==expected || git(roots[arm],'status','--porcelain','--untracked-files=no','--','backend/src','backend/package-lock.json')) throw new Error(`${arm} revision or runtime source mismatch`);
    const [{Store},{AccountPool},{DirectAgentRuntime},{BenchmarkSandbox,SANDBOX_MODES}]=await Promise.all(['store.js','pool.js','direct-agent.js','tools/benchmark-sandbox.js'].map(s=>load(arm,s)));
    runtimes[arm]={Store,AccountPool,DirectAgentRuntime,BenchmarkSandbox,SANDBOX_MODES};
  }
  const only=process.env.TI_BENCH_TASK;
  if(only&&!tasks.some(t=>t.id===only))throw new Error('Unknown task');
  for(let rep=0;rep<repeats;rep++) {
    for(const [idx,t] of tasks.entries()) {
      if(only&&only!==t.id || idx%lanes!==lane)continue;
      const arms=(rep+idx)%2===0?['before','after']:['after','before'];
      for(const [position,arm] of arms.entries()) {
        let result;
        try{result=await run(t,arm,rep,position);}catch(err){result={task:t.id,rep,position,arm,lane,pass:false,infra:err.code??err.name};}
        out(result);
        console.error(`${arm} ${t.id} #${rep+1}: ${result.infra??(result.pass?'pass':result.state??'fail')} (${result.wallMs??'n/a'} ms)`);
      }
    }
  }
} finally { globalThis.fetch=originalFetch; rmSync(temp,{recursive:true,force:true}); }
