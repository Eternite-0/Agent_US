import test from 'node:test';
import assert from 'node:assert/strict';
import { modelToolCatalog, selectionRecoveryHint } from '../src/tools/selection.js';
import { ToolPermissionPolicy } from '../src/tools/policy.js';
import { createWorkspaceTools } from '../src/workspace-tools.js';
import { ToolDispatcher, isParallelReadTool } from '../src/tools/dispatcher.js';

const tools = createWorkspaceTools({ workspaceRoot: process.cwd(), mcpTools: [{ fullName: 'mcp__x__lookup', description: 'always safe read-only', parameters: {}, call: () => { throw Error('unexpected call'); } }] });
const catalog = (live, policy = new ToolPermissionPolicy()) => modelToolCatalog(tools, policy, live);
const pick = (list, n) => list.find(t => t.name === n);

test('wire view intersects exact deny/allow lists incl empty; descriptions cannot grant authority', () => {
  assert.deepEqual(catalog({ allowTools: [] }), []);
  const p = new ToolPermissionPolicy({ allowTools: ['bash','read_file','grep','glob'], alwaysDenyRules: ['grep'] });
  const view = catalog({ permissionMode:'approval', allowTools: ['bash','read_file','glob','write_file','grep'], denyTools: ['glob'] }, p);
  assert.deepEqual(view.map(t=>t.name).sort(), ['bash','read_file']);
  assert.match(pick(view,'bash').description, /read_file/);
  assert.doesNotMatch(pick(view,'bash').description, /grep|glob|inspect_repository/);
  assert.equal(pick(view,'bash').execute, undefined);
  assert.equal(p.evaluate(pick(tools,'bash'),{command:'npm test'},{permissionMode:'approval'}).decision,'ask');
});

test('read-only hides writes and outward MCP, not the argument-dependent shell; live changes refresh deterministically', () => {
  const opts = {permissionMode:'approval'};
  const full = catalog(opts);
  assert.match(pick(full,'mcp__x__lookup').description,/需审批/);
  assert.deepEqual(catalog(opts),full);
  const limited = catalog({...opts,permissionMode:'read-only'});
  assert.equal(pick(limited,'mcp__x__lookup'), undefined);
  assert.equal(pick(limited,'edit_file'), undefined);
  assert.match(pick(limited,'bash').description,/只读命令/);
  for (const name of ['glob','grep','read_file','inspect_repository']) assert.ok(isParallelReadTool(pick(tools,name)));
  assert.equal(isParallelReadTool(pick(tools,'mcp__x__lookup')),false);
});

test('recommendations are limited to a distinct allowed lookup, never translate rejected operations', () => {
  const hint=(command, code='APPROVAL_DENIED', status='rejected_before_effect')=>selectionRecoveryHint({tc:{name:'bash'},parsedArgs:{command},receipt:{errorCode:code,status}},()=>catalog({allowTools:['glob']}));
  assert.match(hint('ls -la'),/glob/); assert.doesNotMatch(hint('ls -la'),/read_file|bash|grep/);
  assert.doesNotMatch(hint('ls /other'),/glob/); assert.doesNotMatch(hint('ls; npm test'),/glob/);
  assert.equal(hint('pwd','NON_ZERO_EXIT','failed'),''); assert.equal(hint('pwd','APPROVAL_REVOKED'),'');
});

test('a fabricated call omitted from the catalog is still denied before execution by the dispatcher',async()=>{
  let ran = false;
  const p = new ToolPermissionPolicy();
  const impl = {...pick(tools,'bash'),execute(){ran=true;}};
  const [r] = await new ToolDispatcher({policy:p}).dispatchBatch({tools:[impl],toolCalls:[{id:'fabricated',name:'bash',arguments:'{"command":"pwd"}'}],allowTools:[],permissionMode:'full-access'});
  assert.ok(r.isError); assert.equal(ran,false);
});

test('direct session reprojects the next request after mid-stream tightening; stale write gets a denial receipt',async()=>{
  const {mkdtempSync,mkdirSync,rmSync,existsSync}=await import('node:fs');
  const {tmpdir}=await import('node:os'); const {join}=await import('node:path');
  const {Store}=await import('../src/store.js'); const {AccountPool}=await import('../src/pool.js');
  const {DirectAgentRuntime}=await import('../src/direct-agent.js');
  const tmp=mkdtempSync(join(tmpdir(),'selection-live-'));const ws=join(tmp,'workspace');mkdirSync(ws);
  const store=new Store(join(tmp,'test.sqlite')); const pool=new AccountPool(store,{root:tmp});
  pool.setDefaultModel('fixture');const catalogs=[];let direct,session;
  const adapter={async *stream({tools}){
    catalogs.push(tools.map(t=>t.name));
    if(catalogs.length===1){
      direct.updateSession(session.id,{permissionMode:'read-only'});
      yield {type:'block-end',index:0,block:{type:'tool-call',id:'stale-write',name:'write_file',arguments:'{"path":"unexpected.txt","content":"not authorized"}'}};
      yield {type:'finish',reason:{kind:'tool-calls'}};
    }else {yield {type:'text-delta',index:0,text:'No write performed.'};yield {type:'finish',reason:{kind:'stop'}};}
  }};
  try {
    direct=new DirectAgentRuntime(store,pool,{adapter,dataRoot:tmp,defaultWorkspace:ws});
    session=direct.createSession({model:'fixture',permissionMode:'approval',toolAllow:['write_file','glob','bash']});
    const id=direct.startTurn(session.id,{input:'Inspect available workspace actions.'}).turn.id;
    const until=Date.now()+5000;while(Date.now()<until&&!['completed','failed','cancelled'].includes(direct.listTurns(session.id).find(t=>t.id===id)?.state))await new Promise(r=>setTimeout(r,20));
    assert.equal(direct.listTurns(session.id).find(t=>t.id===id).state,'completed');
    assert.deepEqual(catalogs[0].sort(),['bash','glob','write_file']);assert.deepEqual(catalogs[1].sort(),['bash','glob']);
    const receipt=store.db.prepare('SELECT status,errorCode FROM tool_receipts WHERE turnId=? AND callId=?').get(id,'stale-write');
    assert.equal(receipt?.status,'rejected_before_effect');assert.equal(receipt?.errorCode,'POLICY_DENIED');assert.equal(existsSync(join(ws,'unexpected.txt')),false);
  }finally{await direct?.close();store.close();rmSync(tmp,{recursive:true,force:true});}
});
