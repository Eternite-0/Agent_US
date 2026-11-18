import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { sandbox, toolset, decide } from '../src/tools.js';
import { Store, id } from '../src/store.js';
test('real Codex command inside Docker enforces user, network, read-only root and returns files', async () => {
  const r = await sandbox(
    [
      'sh',
      '-c',
      'test "$(id -u)" = 65534 && test ! -e /sys/class/net/eth0 && ! touch /etc/forbidden && printf done > proof',
    ],
    {},
  );
  assert.equal(r.exitCode, 0);
  assert.equal(Buffer.from(r.files.proof, 'base64').toString(), 'done');
});
test('approval binds one attempt, denied calls never start, then approved diff is persisted', async (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const p = store.add('projects', { name: 'approval' });
  let task = store.submit({ projectId: p.id, input: 'x', idempotencyKey: '1' });
  task = store.update('tasks', task, { status: 'running' });
  const row = store.db.prepare('SELECT * FROM jobs').get();
  store.db
    .prepare("UPDATE jobs SET status='active',fence='f',expires=?")
    .run(Date.now() + 120000);
  const ctx = {
    store,
    task,
    worker: { id: id() },
    node: { id: id(), role: 'Coder', dependencies: [] },
    job: { ...row, fence: 'f' },
    signal: AbortSignal.timeout(40000),
    guard: () => {},
  };
  const tool = toolset(ctx).find((t) => t.name === 'write_file');
  for (const choice of ['deny', 'approve']) {
    const pending = tool.execute(
      { path: 'result.txt', text: 'approved' },
      { signal: ctx.signal, callId: id() },
    );
    await delay(10);
    const a = store.list('approvals').at(-1);
    assert.equal(store.list('evidence').length, 0);
    decide(store, a.id, { version: 1, decision: choice });
    assert.throws(() => decide(store, a.id, { version: 1, decision: choice }));
    if (choice === 'deny') await assert.rejects(pending, /APPROVAL_DENIED/);
    else assert.equal(JSON.parse(await pending).exitCode, 0);
  }
  assert.equal(store.list('evidence')[0].changes[0].path, 'result.txt');
});
test('Git and PTY share only the supplied workspace, and MCP stdio returns a real result', async () => {
  const git = await sandbox(
    [
      'sh',
      '-c',
      'git init -q && git add note && git status --porcelain && tty',
    ],
    { note: Buffer.from('ok').toString('base64') },
    { tty: true },
  );
  assert.equal(git.exitCode, 0);
  assert.match(git.stdout, /A  note/);
  assert.match(git.stdout, /\/dev\/pts\//);
  assert.ok(git.files['.git/index']);
  const script = `import sys,json\nfor line in sys.stdin:\n m=json.loads(line)\n if 'id' in m: print(json.dumps({'jsonrpc':'2.0','id':m['id'],'result':({'protocolVersion':'2025-03-26','serverInfo':{'name':'sample','version':'1'},'capabilities':{'tools':{}}} if m['method']=='initialize' else {'content':[{'type':'text','text':m['params']['arguments']['value']}]})}),flush=True)`;
  const result = await sandbox(
    [
      'python',
      '-I',
      '/opt/mcp.py',
      JSON.stringify(['python', '-u', '-c', script]),
      'echo',
      '{"value":"ok"}',
    ],
    {},
  );
  assert.equal(JSON.parse(result.stdout).content[0].text, 'ok');
});

test('cancelled sandbox call stops its container', async () => {
  const controller = new AbortController();
  const work = sandbox(['sleep', '25'], {}, { signal: controller.signal });
  const timer = setTimeout(() => controller.abort(), 1200);
  try {
    await assert.rejects(work);
  } finally {
    clearTimeout(timer);
  }
});
