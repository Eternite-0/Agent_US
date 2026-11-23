// Rejudge frozen outputs without provider calls. Preserve the original row and
// fail closed if artifact integrity or the scope of the judge correction differs.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { BenchmarkSandbox, SANDBOX_MODES } from '../src/tools/benchmark-sandbox.js';
import { tasks, workspaceFiles, judgeScript, fixtureDigest } from './fixtures/real-model-tasks.mjs';

const [artifacts,...files]=process.argv.slice(2);
assert.ok(artifacts && files.length,'Supply artifacts root and original formal logs');
const task=tasks.find(t=>t.id==='07-normalize-refactor');
const rows=files.flatMap(p=>readFileSync(p,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse));
const affected=rows.filter(r=>r.task===task.id);
assert.equal(affected.length,10,'Require all five repeats from both arms');
assert.equal(new Set(affected.map(r=>`${r.arm}/${r.rep}`)).size,10);
for(const row of rows) {
  if(row.task!==task.id){console.log(JSON.stringify(row));continue;}
  assert.ok(['before','after'].includes(row.arm)&&Number.isInteger(row.rep)&&row.rep>=0&&row.rep<5);
  assert.equal(row.unauthorizedChanges.length,0);
  assert.ok(row.changedPaths.every(p=>task.writable.includes(p)));
  assert.notEqual(row.fixtureDigest,fixtureDigest(task),'Rows must use original judge, not duplicate scoring');
  const root=mkdtempSync(join(tmpdir(),'agent-ti236-rejudge-'));
  try {
    function put(p,buf){const path=join(root,p);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,buf);}
    for(const [p,buf] of Object.entries(workspaceFiles(task)))put(p,buf);
    const artifactDir=resolve(artifacts,`${task.id}-${row.rep}-${row.arm}`);
    for(const p of row.changedPaths) {
      if(row.artifactDigests[p]===null){rmSync(join(root,p),{force:true});continue;}
      const buf=readFileSync(join(artifactDir,p));
      assert.equal(createHash('sha256').update(buf).digest('hex'),row.artifactDigests[p]);
      put(p,buf);
    }
    const sandbox=new BenchmarkSandbox({mode:SANDBOX_MODES.NODE_PERMISSION,workspaceRoot:root,timeoutMs:8000,cpuLimitSec:2,maxOutputBytes:32000});
    const judge=await sandbox.runHiddenAcceptance({scriptSource:judgeScript(task)});
    const independent=judge.passed&&row.publicPass&&task.writable.every(p=>row.changedPaths.includes(p));
    const pass=independent&&row.state==='completed'&&!row.timedOut&&Object.values(row.order).every(Boolean);
    console.log(JSON.stringify({...row,hidden:judge.passed,hiddenExit:judge.exitCode,pass,independent,
      failedThenRecovered:row.failedCalls>0&&pass,
      rejudge:{reason:'escaped RegExp in generated test source',correctedJudgeDigest:fixtureDigest(task),original:{hidden:row.hidden,exit:row.hiddenExit,pass:row.pass,independent:row.independent}}}));
  } finally {rmSync(root,{recursive:true,force:true});}
}
