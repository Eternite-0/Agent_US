import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {z} from 'zod';
import {Fault,id} from './store.js';
import {docker} from './docker.js';
const path=z.string().min(1).max(160).regex(/^(?!.*(?:^|\/)\.\.(?:\/|$))[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/);
const filemap=z.record(path,z.base64().max(88000));
const result=z.strictObject({exitCode:z.number().int(),stdout:z.string().max(16384),stderr:z.string().max(16384),files:filemap});
const args=z.array(z.string().max(16000)).min(1).max(64);
const definitions={shell:z.strictObject({argv:args}),pty:z.strictObject({argv:args}),git:z.strictObject({args}),read_file:z.strictObject({path}),write_file:z.strictObject({path,text:z.string().max(16000)}),mcp:z.strictObject({server:z.string().max(64),name:z.string().max(128),argumentsJson:z.string().max(4096)})};
const hash=v=>createHash('sha256').update(v).digest('hex');
export async function sandbox(argv,files,{signal,image='agent-us/worker:1',tty=false}={}){
 const name='agent-work-'+id();const timeout=AbortSignal.timeout(25000);signal=signal?AbortSignal.any([signal,timeout]):timeout;
 try{const raw=await docker(['run','--rm','--pull=never','-i','--name',name,'--network=none','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--pids-limit=64','--memory=256m','--memory-swap=256m','--cpus=1','--user=65534:65534','--tmpfs','/work:rw,nosuid,nodev,size=8m,uid=65534,gid=65534','--tmpfs','/tmp:rw,nosuid,nodev,size=24m,mode=1777',image],{signal,input:JSON.stringify({argv,files,tty})});return result.parse(JSON.parse(raw));}
 finally{if(signal.aborted)await docker(['rm','-f',name],{signal:AbortSignal.timeout(5000)}).catch(()=>{});}
}
export function decide(db,approvalId,{version,decision}){return db.tx(()=>{
 const record=db.get('approvals',approvalId);if(record.version!==version||record.status!=='pending'||record.expires<Date.now())throw new Fault('APPROVAL_INACTIVE');
 if(!db.db.prepare("SELECT 1 FROM jobs WHERE id=? AND fence=? AND status='active' AND expires>=?").get(record.jobId,record.fence,Date.now())||db.get('tasks',record.taskId).status!=='running')throw new Fault('LEASE_LOST');
 return db.update('approvals',record,{status:decision});});}
export function toolset(execution,{image,mcp={}}={}){
 const {store,task,worker,node,job,signal,guard}=execution;let files=Object.create(null);
 const inherited=store.list('artifacts',{taskId:task.id,limit:500}).filter(a=>a.published&&node.dependencies.includes(a.key));
 for(const a of inherited) for(const [p,v] of Object.entries(a.files??{}))files[`inputs/${a.key}/${p}`]=v;
 const writable=node.role==='Coder'||node.role==='Tester';
 return Object.entries(definitions).filter(([name])=>writable||name==='read_file').map(([name,schema])=>({name,description:`${name} in the isolated assignment workspace`,parameters:z.toJSONSchema(schema),output:{schema:{type:'string'},render:(_,v)=>[{type:'text',text:v}]},async execute(raw,exec){
  guard();const action=schema.parse(raw);const combined=AbortSignal.any([signal,exec.signal]);combined.throwIfAborted();
  if(name==='read_file'){if(!Object.hasOwn(files,action.path))throw new Fault('FILE_NOT_FOUND');return Buffer.from(files[action.path],'base64').toString('utf8').slice(0,16384);}
  let argv=action.argv;if(name==='git')argv=['git',...action.args];if(name==='write_file')argv=['python','-c','import pathlib,sys;p=pathlib.Path(sys.argv[1]);p.parent.mkdir(parents=True,exist_ok=True);p.write_text(sys.argv[2])',action.path,action.text];
  if(name==='mcp'){if(!Object.hasOwn(mcp,action.server))throw new Fault('UNKNOWN_MCP_SERVER');JSON.parse(action.argumentsJson);argv=['python','-I','/opt/mcp.py',JSON.stringify(mcp[action.server]),action.name,action.argumentsJson];}
  const digest=hash(JSON.stringify([worker.id,exec.callId,name,action,files]));const approval=store.add('approvals',{status:'pending',policy:1,fence:job.fence,jobId:job.id,workerId:worker.id,assignmentId:node.id,callId:exec.callId,tool:name,action,digest,expires:Date.now()+120000},task.projectId,task.id);
  for(;;){guard();combined.throwIfAborted();const a=store.get('approvals',approval.id);if(a.status==='approve'&&a.expires>=Date.now()){store.update('approvals',a,{status:'consumed'});break;}if(a.status!=='pending'||a.expires<Date.now())throw new Fault('APPROVAL_DENIED');await delay(100,undefined,{signal:combined});}
  const evidence=store.add('evidence',{status:'executing',workerId:worker.id,assignmentId:node.id,approvalId:approval.id,digest},task.projectId,task.id);
  try{const outcome=await sandbox(argv,files,{signal:combined,image,tty:name==='pty'});guard();const changes=[];
   for(const p of new Set([...Object.keys(files),...Object.keys(outcome.files)])){if(files[p]!==outcome.files[p])changes.push({path:p,before:files[p]??null,after:outcome.files[p]??null});}
   const {files:next,...summary}=outcome;store.update('evidence',evidence,{status:'finished',...summary,changes});files=next;execution.files=next;return JSON.stringify(summary);
  }catch(e){store.update('evidence',evidence,{status:'failed'});throw e;}
 }}));
}
