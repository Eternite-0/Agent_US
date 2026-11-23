import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { tasks, workspaceFiles, judgeScript, fixtureDigest } from '../scripts/fixtures/real-model-tasks.mjs';

function fixture(t, spec) {
  const home=mkdtempSync(join(tmpdir(),'real-model-spec-'));
  const ws=join(home,'workspace');
  const put=(p,contents)=>{const target=join(ws,p);mkdirSync(dirname(target),{recursive:true});writeFileSync(target,contents);};
  for(const [p,contents] of Object.entries(workspaceFiles(spec)))put(p,contents);
  const judge=join(home,'judge.test.mjs');
  writeFileSync(judge,judgeScript(spec));
  const env={...process.env,WORKSPACE_ROOT:ws};
  delete env.NODE_TEST_CONTEXT;
  const run=(p)=>spawnSync(process.execPath,['--test',p],{cwd:ws,env,timeout:5000,encoding:'utf8'});
  t.after(()=>rmSync(home,{recursive:true,force:true}));
  return { put, hidden:()=>run(judge), public:()=>run('test/public.test.mjs') };
}

test('corpus includes ten distinct frozen prompts, repository fixtures and hidden judges',()=>{
  assert.equal(tasks.length,10);assert.equal(new Set(tasks.map(t=>t.id)).size,10);
  assert.equal(new Set(tasks.map(fixtureDigest)).size,10);
  assert.equal(tasks.filter(t=>t.requiredMcp?.length).length,3);
});

test('refactor judge distinguishes behavior-preserving extraction from duplicate implementations',t=>{
  const f=fixture(t,tasks.find(x=>x.id==='07-normalize-refactor'));
  assert.equal(f.public().status,0);
  f.put('lib/sku.mjs','export const normalizeSku = s => String(s).trim().toUpperCase();');
  assert.equal(f.hidden().status,1,'Behavior alone is not enough: callers must delegate');
  f.put('lib/receive.mjs',`import {normalizeSku} from './sku.mjs';\nexport const receive=s=>'in:'+normalizeSku(s);`);
  f.put('lib/ship.mjs',`import {normalizeSku} from "./sku.mjs";\nexport const ship=s=>'out:'+normalizeSku(s);`);
  const rejudged=f.hidden();assert.equal(rejudged.status,0,rejudged.stdout);
});

test('reproduction tasks start with actually failing public tests',t=>{
  for(const spec of tasks.filter(x=>x.initialFailure))assert.equal(fixture(t,spec).public().status,1);
});
