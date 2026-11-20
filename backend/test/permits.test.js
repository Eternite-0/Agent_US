import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { Store, id } from '../src/store.js';
import { Engine } from '../src/engine.js';
import {
  ExecutePermitRegistry,
  RejectedBeforeEffectError,
} from '../src/permits.js';
import {
  toolset,
  decide,
  reconcile,
  checkHardBlockedCommand,
  dispatchWithPermit,
} from '../src/tools.js';
import { model, Script } from './fixtures.js';

test('ExecutePermitRegistry enforces one-shot WeakMap capabilities and rejects forgery/replay', async () => {
  const permits = new ExecutePermitRegistry();
  const owner = { worker: 'w1' };
  const binding = {
    owner,
    effectId: 'eff-1',
    approvalId: 'app-1',
    evidenceId: 'ev-1',
    callId: 'c-1',
    attempt: 1,
  };
  const permit = permits.issue(binding);
  assert.equal(Object.keys(permit).length, 0);
  assert.ok(Object.isFrozen(permit));

  // Forged empty object or JSON round-trip fails.
  await assert.rejects(
    () => dispatchWithPermit({}, binding, permits, () => 'nope'),
    (e) => e.code === 'E_EXECUTE_PERMIT',
  );
  await assert.rejects(
    () =>
      dispatchWithPermit(
        JSON.parse(JSON.stringify(permit)),
        binding,
        permits,
        () => 'nope',
      ),
    (e) => e.code === 'E_EXECUTE_PERMIT',
  );

  // Wrong owner fails without consuming valid permit.
  await assert.rejects(
    () =>
      dispatchWithPermit(
        permit,
        { ...binding, owner: { worker: 'other' } },
        permits,
        () => 'nope',
      ),
    (e) => e.code === 'E_EXECUTE_PERMIT',
  );

  // Exact match succeeds once; second replay fails.
  let ran = 0;
  const out = await dispatchWithPermit(permit, binding, permits, () => ++ran);
  assert.equal(out, 1);
  await assert.rejects(
    () => dispatchWithPermit(permit, binding, permits, () => ++ran),
    (e) => e.code === 'E_EXECUTE_PERMIT',
  );
  assert.equal(ran, 1);

  // Closed registry refuses new permits.
  permits.close();
  assert.throws(
    () => permits.issue({ ...binding, effectId: 'eff-2' }),
    (e) => e.code === 'E_EXECUTE_PERMIT',
  );
});

test('hard-blocked commands reject before effect with zero approvals and zero executions', async (t) => {
  assert.equal(checkHardBlockedCommand(['rm', '-rf', '/']), 'rm-root-or-home');
  assert.equal(
    checkHardBlockedCommand(['sudo', 'sh', '-c', 'echo hi && rm -rf ~/']),
    'rm-root-or-home',
  );
  assert.equal(
    checkHardBlockedCommand(['sh', '-c', ':(){ :|:& };:']),
    'fork-bomb',
  );
  assert.equal(
    checkHardBlockedCommand(['dd', 'if=/dev/zero', 'of=/dev/sda']),
    'block-device-write',
  );
  assert.equal(checkHardBlockedCommand(['sh', '-c', 'echo safe']), null);

  const store = new Store(':memory:');
  t.after(() => store.close());
  const p = store.add('projects', { name: 'hardblock' });
  let task = store.submit({ projectId: p.id, input: 'x', idempotencyKey: '1' });
  task = store.update('tasks', task, { status: 'running' });
  let runnerCalls = 0;
  const ctx = {
    store,
    task,
    worker: { id: id() },
    node: { id: id(), role: 'Coder', dependencies: [] },
    job: { id: id(), fence: 'f' },
    signal: AbortSignal.timeout(10000),
    guard: () => {},
  };
  const shellTool = toolset(ctx, {
    runner: async () => {
      runnerCalls++;
      return { exitCode: 0, stdout: '', stderr: '', files: {} };
    },
  }).find((x) => x.name === 'shell');

  await assert.rejects(
    () =>
      shellTool.execute(
        { argv: ['rm', '-rf', '/'] },
        { signal: ctx.signal, callId: id() },
      ),
    (e) =>
      e instanceof RejectedBeforeEffectError &&
      e.code === 'POLICY_HARD_BLOCKED' &&
      e.effect === 'none',
  );
  assert.equal(runnerCalls, 0);
  assert.equal(store.list('approvals').length, 0);
  const [ev] = store.list('evidence');
  assert.equal(ev.status, 'rejected_before_effect');
  assert.equal(ev.effect, 'none');
  assert.equal(ev.code, 'POLICY_HARD_BLOCKED');
});

test('tool argument auto-recovery gives corrective hint once and disables tool on 2nd failure', async (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const p = store.add('projects', { name: 'arg-recovery' });
  let task = store.submit({ projectId: p.id, input: 'x', idempotencyKey: '1' });
  task = store.update('tasks', task, { status: 'running' });
  const ctx = {
    store,
    task,
    worker: { id: id() },
    node: { id: id(), role: 'Coder', dependencies: [] },
    job: { id: id(), fence: 'f' },
    signal: AbortSignal.timeout(10000),
    guard: () => {},
  };
  const writeTool = toolset(ctx, {
    approvalMode: 'workspace-write',
    runner: async (_argv, files) => ({
      exitCode: 0,
      stdout: '',
      stderr: '',
      files: { ...files, 'ok.txt': Buffer.from('hi').toString('base64') },
    }),
  }).find((x) => x.name === 'write_file');

  // 1st invalid call: corrective hint (1 remaining), no throw.
  const first = await writeTool.execute(
    { path: '../escape.txt', text: 'bad' },
    { signal: ctx.signal, callId: id() },
  );
  assert.match(first, /1 corrective attempt\(s\) remaining/);

  // 2nd consecutive invalid call: sticky disabled for the turn.
  const second = await writeTool.execute(
    { path: '', text: 'bad' },
    { signal: ctx.signal, callId: id() },
  );
  assert.match(second, /Disabled for the rest of this turn/);

  // 3rd call (even valid!) remains disabled for this turn.
  const third = await writeTool.execute(
    { path: 'ok.txt', text: 'hi' },
    { signal: ctx.signal, callId: id() },
  );
  assert.match(third, /Disabled for the rest of this turn/);
  assert.equal(store.list('approvals').length, 0);
});

test('non-replayable outcome_unknown parks job in reconciliation instead of silently re-running', () => {
  const store = new Store(':memory:');
  try {
    const p = store.add('projects', { name: 'reconcile' });
    let task = store.submit({ projectId: p.id, input: 'x', idempotencyKey: '1' });
    task = store.update('tasks', task, { status: 'running' });
    const node = store.add(
      'assignments',
      {
        key: 'run',
        role: 'Coder',
        objective: 'run cmd',
        acceptance: 'done',
        dependencies: [],
        status: 'running',
      },
      p.id,
      task.id,
    );
    // Replace initial plan job with an active expired work job that had executing shell evidence.
    store.db.prepare('DELETE FROM jobs').run();
    const jobId = id();
    store.db
      .prepare(
        "INSERT INTO jobs(id,taskId,kind,payload,status,fence,expires,attempts) VALUES(?,?,?,?,'active','old-fence',0,1)",
      )
      .run(jobId, task.id, 'work', JSON.stringify({ assignmentId: node.id }));
    const worker = store.add(
      'workers',
      { jobId, role: 'Coder', status: 'running', assignmentId: node.id },
      p.id,
      task.id,
    );
    const ev = store.add(
      'evidence',
      {
        status: 'executing',
        tool: 'shell',
        replayable: false,
        workerId: worker.id,
        assignmentId: node.id,
        digest: 'abc',
      },
      p.id,
      task.id,
    );

    const engine = new Engine({ store, root: tmpdir(), models: [model] });
    // Claim must NOT re-run the job; it must park it for reconciliation!
    assert.equal(engine.claim(), undefined);
    assert.equal(store.get('evidence', ev.id).status, 'outcome_unknown');
    assert.equal(store.get('assignments', node.id).status, 'awaiting_reconciliation');
    const [rec] = store.list('approvals', { taskId: task.id });
    assert.equal(rec.kind, 'reconciliation');
    assert.equal(rec.status, 'pending');
    assert.equal(rec.evidenceId, ev.id);

    // Confirming 'succeeded' wakes the job with reconciled metadata.
    reconcile(store, rec.id, {
      version: rec.version,
      outcome: 'succeeded',
      note: 'Checked target system: command succeeded',
    });
    assert.equal(store.get('evidence', ev.id).status, 'reconciled_succeeded');
    const nextJob = engine.claim();
    assert.ok(nextJob);
    assert.equal(nextJob.payload.reconciled[0].outcome, 'succeeded');
  } finally {
    store.close();
  }
});

test('approval park releases worker slot and decision resumes and consumes exact pre-approved action', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'park-resume-'));
  const store = new Store(join(root, 'engine.sqlite'));
  const p = store.add('projects', { name: 'park' });
  const task = store.submit({
    projectId: p.id,
    input: 'write file',
    idempotencyKey: 'park-1',
  });
  let runnerCalls = 0;
  const plan = {
    type: 'coding',
    complexity: 'simple',
    risk: 'low',
    nodes: [
      {
        key: 'write',
        role: 'Coder',
        objective: 'write out.txt',
        acceptance: 'out.txt exists',
        dependencies: [],
        requiredFiles: ['out.txt'],
      },
    ],
  };
  const adapter = new Script(async (o) => {
    const sys =
      o.system ??
      o.messages
        .filter((m) => m.role === 'system')
        .flatMap((m) => m.content)
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
    if (sys.includes('You dispatch')) return JSON.stringify(plan);
    if (sys.includes('Evaluate the original'))
      return JSON.stringify({ accepted: true, reason: 'ok' });
    if (o.messages.some((m) => m.role === 'tool')) return 'done writing out.txt';
    return {
      type: 'tool-call',
      id: 'c_write',
      name: 'write_file',
      arguments: JSON.stringify({ path: 'out.txt', text: 'hello parked' }),
    };
  });
  const engine = new Engine({
    store,
    root,
    models: [model],
    adapter,
    approvalParkMs: 120,
    tools: (exec) =>
      toolset(exec, {
        runner: async (_argv, files) => {
          runnerCalls++;
          return {
            exitCode: 0,
            stdout: 'ok',
            stderr: '',
            files: {
              ...files,
              'out.txt': Buffer.from('hello parked').toString('base64'),
            },
          };
        },
      }),
  });
  t.after(async () => {
    await engine.stop();
    store.close();
  });
  engine.start();

  // Wait until approval is parked and worker slot is freed.
  let parked;
  for (let i = 0; i < 80; i++) {
    const [a] = store.list('approvals', { taskId: task.id });
    if (a?.parked && engine.active.size === 0) {
      parked = a;
      break;
    }
    await delay(50);
  }
  assert.ok(parked, 'expected approval to park and free worker slot');
  assert.equal(runnerCalls, 0);
  const [assignment] = store.list('assignments', { taskId: task.id });
  assert.equal(assignment.status, 'awaiting_approval');

  // Approve the parked decision -> wakes job, consumes pre-approved exact digest, finishes task!
  decide(store, parked.id, { version: parked.version, decision: 'approve' });
  for (let i = 0; i < 100; i++) {
    if (['completed', 'failed'].includes(store.get('tasks', task.id).status))
      break;
    await delay(50);
  }
  assert.equal(store.get('tasks', task.id).status, 'completed');
  assert.equal(runnerCalls, 1);
  // Only 1 approval record was ever created and consumed (no double-prompting on resume!).
  const allApprovals = store.list('approvals', { taskId: task.id });
  assert.equal(allApprovals.length, 1);
  assert.equal(allApprovals[0].status, 'consumed');
});
