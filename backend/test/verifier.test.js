import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { affectedNodes } from '../src/router.js';
import { toolset } from '../src/tools.js';
import { verifyTurn, buildRepairNote, decideRepair } from '../src/verifier.js';
import { model, Script } from './fixtures.js';

test('verifyTurn detects deterministic T0 failures without false-positives on clean replies', () => {
  // Clean simple Coder reply with no requiredFiles and no fake test claim passes.
  assert.equal(
    verifyTurn({
      events: [],
      text: 'result',
      node: { role: 'Coder' },
      execution: { evidenceCount: 0, files: {} },
    }).verdict,
    'pass',
  );

  // Unverified test claim with 0 tool evidence fails.
  const claim = verifyTurn({
    events: [],
    text: 'All tests passed after my edits.',
    node: { role: 'Coder' },
    execution: { evidenceCount: 0, files: {} },
  });
  assert.equal(claim.verdict, 'fail');
  assert.ok(claim.reasons.includes('unverified_coder_claim'));

  // Tool call printed as plain text fails.
  const textTool = verifyTurn({
    events: [{ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '{"tool":"shell","argv":["ls"]}' }] } } }],
    text: '{"tool":"shell","argv":["ls"]}',
    node: { role: 'Coder' },
    execution: { evidenceCount: 0, files: {} },
  });
  assert.ok(textTool.reasons.includes('tool_call_as_text'));

  // Missing requiredFiles fails and names missing file in repair note.
  const missing = verifyTurn({
    events: [],
    text: 'Done!',
    node: { role: 'Coder', requiredFiles: ['proof.txt'] },
    execution: { evidenceCount: 1, files: {} },
  });
  assert.ok(missing.reasons.includes('required_files_missing'));
  const note = buildRepairNote(missing);
  assert.match(note, /proof\.txt/);
  assert.match(note, /do not undo/i);

  // Bounded repair allows round 1 only.
  assert.equal(decideRepair({ round: 1, verdict: missing }), 'repair');
  assert.equal(decideRepair({ round: 2, verdict: missing }), 'complete');
});

test('T0 verifier catches missing requiredFiles inside warm session and repairs without restarting job', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'verifier-repair-'));
  const store = new Store(join(root, 'engine.sqlite'));
  const p = store.add('projects', { name: 'repair' });
  const task = store.submit({
    projectId: p.id,
    input: 'deliver report.md',
    idempotencyKey: 'rep-1',
  });
  const plan = {
    type: 'coding',
    complexity: 'simple',
    risk: 'low',
    nodes: [
      {
        key: 'doc',
        role: 'Coder',
        objective: 'write report.md',
        acceptance: 'report.md exists',
        dependencies: [],
        requiredFiles: ['report.md'],
      },
    ],
  };
  let coderTurns = 0;
  const adapter = new Script(async (o) => {
    const sys = o.messages
      .filter((m) => m.role === 'system')
      .flatMap((m) => m.content)
      .map((b) => b.text)
      .join('\n');
    if (sys.includes('You dispatch')) return JSON.stringify(plan);
    if (sys.includes('Evaluate the original'))
      return JSON.stringify({ accepted: true, reason: 'verified' });
    if (o.messages.some((m) => m.role === 'tool')) return 'Wrote report.md.';
    coderTurns++;
    if (coderTurns === 1) {
      // First attempt forgets to write required file!
      return 'I finished the report.';
    }
    // Second turn inside SAME warm session sees repair note and creates the file!
    const lastUser = o.messages.at(-1).content[0].text;
    assert.match(lastUser, /required_files_missing/);
    return {
      type: 'tool-call',
      id: 'c_rep',
      name: 'write_file',
      arguments: JSON.stringify({ path: 'report.md', text: '# Report' }),
    };
  });
  const engine = new Engine({
    store,
    root,
    models: [model],
    adapter,
    tools: (exec) =>
      toolset(exec, {
        approvalMode: 'workspace-write',
        runner: async (_argv, files) => ({
          exitCode: 0,
          stdout: '',
          stderr: '',
          files: {
            ...files,
            'report.md': Buffer.from('# Report').toString('base64'),
          },
        }),
      }),
  });
  t.after(async () => {
    await engine.stop();
    store.close();
  });
  engine.start();
  for (let i = 0; i < 120; i++) {
    if (['completed', 'failed'].includes(store.get('tasks', task.id).status))
      break;
    await delay(50);
  }
  assert.equal(store.get('tasks', task.id).status, 'completed');
  // Only ONE Coder worker was created (warm repair avoided full job retry!).
  const coders = store
    .list('workers', { taskId: task.id })
    .filter((w) => w.role === 'Coder');
  assert.equal(coders.length, 1);
  const repairEvents = store
    .events(0, task.id)
    .filter((e) => e.type === 'verifier.repair');
  assert.equal(repairEvents.length, 1);
});

test('targeted DAG rework resets only failedNodes and their transitive dependents', async (t) => {
  const nodes = [
    { key: 'a', dependencies: [] },
    { key: 'b', dependencies: [] },
    { key: 'c', dependencies: ['b'] },
    { key: 'd', dependencies: ['c'] },
  ];
  assert.deepEqual([...affectedNodes(nodes, ['b'])].sort(), ['b', 'c', 'd']);

  const root = await mkdtemp(join(tmpdir(), 'dag-target-'));
  const store = new Store(join(root, 'engine.sqlite'));
  const p = store.add('projects', { name: 'targeted' });
  const task = store.submit({
    projectId: p.id,
    input: 'multi-node',
    idempotencyKey: 't-1',
  });
  const plan = {
    type: 'engineering',
    complexity: 'medium',
    risk: 'low',
    nodes: [
      { key: 'a', role: 'Researcher', objective: 'a', acceptance: 'ok', dependencies: [] },
      { key: 'b', role: 'Researcher', objective: 'b', acceptance: 'ok', dependencies: [] },
      { key: 'c', role: 'Researcher', objective: 'c', acceptance: 'ok', dependencies: ['b'] },
    ],
  };
  let reviewCalls = 0;
  const runCounts = { a: 0, b: 0, c: 0 };
  const adapter = new Script(async (o) => {
    const payload = JSON.parse(o.messages.at(-1).content[0].text);
    if (payload.criteria) {
      reviewCalls++;
      return JSON.stringify(
        reviewCalls === 1
          ? { accepted: false, reason: 'Fix b', failedNodes: ['b'] }
          : { accepted: true, reason: 'All good' },
      );
    }
    if (!payload.assignment) return JSON.stringify(plan);
    const k = payload.assignment.objective;
    runCounts[k]++;
    return `output-${k}-v${runCounts[k]}`;
  });
  const engine = new Engine({ store, root, models: [model], adapter });
  t.after(async () => {
    await engine.stop();
    store.close();
  });
  engine.start();
  for (let i = 0; i < 160; i++) {
    if (['completed', 'failed'].includes(store.get('tasks', task.id).status))
      break;
    await delay(50);
  }
  assert.equal(store.get('tasks', task.id).status, 'completed');
  // Node 'a' was NOT reset (ran once!), while 'b' and dependent 'c' ran twice!
  assert.equal(runCounts.a, 1);
  assert.equal(runCounts.b, 2);
  assert.equal(runCounts.c, 2);
  const published = store
    .list('artifacts', { taskId: task.id })
    .filter((a) => a.published);
  assert.equal(published.length, 3);
  assert.equal(published.find((x) => x.key === 'a').text, 'output-a-v1');
  assert.equal(published.find((x) => x.key === 'b').text, 'output-b-v2');
  assert.equal(published.find((x) => x.key === 'c').text, 'output-c-v2');
});
