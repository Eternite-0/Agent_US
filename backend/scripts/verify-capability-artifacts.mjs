// Offline verification. Rebuild in disposable directories; do not import candidate code
// into this process. Hidden and public tests execute in the original read-only sandbox.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { gunzipSync } from 'node:zlib';
import { BenchmarkSandbox, SANDBOX_MODES } from '../src/tools/benchmark-sandbox.js';
import { tasks as originals, workspaceFiles, judgeScript, fixtureDigest } from './fixtures/real-model-tasks.mjs';
import { capabilityTasks } from './fixtures/capability-tasks.mjs';
const [gz,dir] = process.argv.slice(2);
assert.ok(gz && dir,'Supply published traces.jsonl.gz and extracted artifacts directory');
const specs=new Map([...originals,...capabilityTasks].map(t=>[t.id,t]));
const root=realpathSync(dir); let files=0,judged=0,infra=0; const unique=new Set();
for(const line of gunzipSync(readFileSync(gz)).toString('utf8').trim().split('\n')){
  const row=JSON.parse(line); const t=specs.get(row.task);assert.ok(t);
  assert.ok(['before','after'].includes(row.arm)&&Number.isInteger(row.rep)&&row.rep>=0&&row.rep<5);
  const key=`${t.id}-${row.rep}-${row.arm}`;assert.ok(!unique.has(key));unique.add(key);
  if(row.infra){assert.equal(row.pass,false);infra++;continue;}
  assert.equal(row.fixtureDigest,fixtureDigest(t));assert.deepEqual(row.unauthorizedChanges,[]);
  const ws=mkdtempSync(join(tmpdir(),'ti237-verify-'));
  try {
    const put=(p,b)=>{mkdirSync(dirname(join(ws,p)),{recursive:true});writeFileSync(join(ws,p),b);};
    for(const [p,src] of Object.entries(workspaceFiles(t)))put(p,src);
    for(const p of row.changedPaths){
      assert.ok(t.writable.includes(p));const digest=row.artifactDigests[p];
      if(digest===null){rmSync(join(ws,p),{force:true});continue;}
      const path=realpathSync(resolve(root,key,p));assert.ok(path.startsWith(root+sep));
      const b=readFileSync(path);assert.equal(createHash('sha256').update(b).digest('hex'),digest);put(p,b);files++;
    }
    const sb=new BenchmarkSandbox({mode:SANDBOX_MODES.NODE_PERMISSION,workspaceRoot:ws,timeoutMs:8000,cpuLimitSec:2,maxOutputBytes:32000});
    const h=await sb.runHiddenAcceptance({scriptSource:judgeScript(t)});assert.equal(h.passed,row.hidden,key);
    const pub=t.test?await sb.execArgv(['node','--test','test/public.test.mjs'],{workspaceReadOnly:true}):null;
    const publicPass=!t.test||pub.exitCode===0&&!pub.timedOut; assert.equal(publicPass,row.publicPass,key);
    const independent=h.passed&&publicPass&&t.writable.every(p=>row.changedPaths.includes(p));assert.equal(row.independent,independent,key);
    assert.equal(row.pass,independent&&row.state==='completed'&&!row.timedOut&&Object.values(row.order).every(Boolean),key);judged++;
  }finally{rmSync(ws,{recursive:true,force:true});}
}
assert.equal(unique.size,140);console.log(JSON.stringify({assigned:unique.size,judged,infra,sha256VerifiedFiles:files}));
