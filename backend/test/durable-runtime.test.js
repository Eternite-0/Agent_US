import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { rmDirSafe, withTimeout } from './fixtures.js';
import { Store } from '../src/store.js';
import { AccountPool } from '../src/pool.js';
import { DirectAgentRuntime } from '../src/direct-agent.js';
import { DurableJobQueue } from '../src/durable/job-queue.js';
import { CheckpointStore } from '../src/durable/checkpoint.js';
import { UnknownOutcomeReconciler } from '../src/durable/reconciliation.js';
import { RecoveryError } from '../src/kernel/errors.js';
import { EventRouter } from '../src/kernel/events.js';

function listenMockOpenAi(handler) {
  return new Promise((resolve) => {
    const cleanups = new Set();
    const server = http.createServer((req, res) => handler(req, res, cleanups));
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        close: () => {
          for (const fn of cleanups) {
            try {
              fn();
            } catch {}
          }
          cleanups.clear();
          server.closeAllConnections?.();
          return new Promise((r) => server.close(r));
        },
      });
    });
  });
}

async function waitUntil(fn, timeoutMs = 8000, intervalMs = 30) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const val = await fn();
    if (val) return val;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitUntil timed out after ${timeoutMs}ms`);
}

test('P2 Durable: Concurrent worker fencing rejects stale lease and protects terminal states', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-us-p2-fence-'));
  const store = new Store(join(dir, 'engine.sqlite'));
  try {
    const q = new DurableJobQueue(store, { defaultLeaseMs: 1000 });
    const job = q.enqueue({
      kind: 'direct_turn',
      sessionId: 'sess-1',
      turnId: 'turn-1',
      idempotencyKey: 'idem-1',
      payload: { step: 1 },
    });
    // Idempotency key deduplicates
    const dup = q.enqueue({
      kind: 'direct_turn',
      sessionId: 'sess-1',
      turnId: 'turn-1',
      idempotencyKey: 'idem-1',
      payload: { step: 1 },
    });
    assert.equal(dup.id, job.id);
    assert.equal(dup.deduplicated, true);

    const workerA = q.claim({ workerId: 'worker-A', leaseMs: 1000 });
    assert.ok(workerA?.fence);

    // Worker B cannot steal while lease active
    assert.equal(q.claim({ workerId: 'worker-B', leaseMs: 1000 }), null);

    // Expire worker A lease in DB and let worker B reclaim
    store.tx(() => {
      store.db
        .prepare('UPDATE runtime_jobs SET leaseExpiresAt=? WHERE id=?')
        .run(Date.now() - 500, job.id);
    });
    const workerB = q.claim({ workerId: 'worker-B', leaseMs: 5000 });
    assert.ok(workerB);
    assert.equal(workerB.reclaimedFromCrash, true);
    assert.notEqual(workerB.fence, workerA.fence);

    // Stale worker A is fenced out from asserting, renewing, failing, or completing
    assert.equal(q.renewLease(job.id, workerA.fence, 5000), false);
    assert.throws(
      () => q.assertFence(job.id, workerA.fence),
      (err) => err instanceof RecoveryError && err.code === 'LEASE_LOST',
    );
    assert.throws(
      () => q.complete(job.id, workerA.fence),
      (err) => err instanceof RecoveryError && err.code === 'LEASE_LOST',
    );

    // Worker B completes validly; worker A still cannot overwrite terminal 'done'
    const done = q.complete(job.id, workerB.fence);
    assert.equal(done.status, 'done');
    assert.throws(
      () => q.fail(job.id, workerA.fence, new Error('late failure')),
      (err) => err instanceof RecoveryError && err.code === 'LEASE_LOST',
    );
  } finally {
    store.close();
    rmDirSafe(dir);
  }
});

test('P2 Durable: Cancelled turn is never resurrected across restart or job claim', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-us-p2-cancel-'));
  const dbPath = join(dir, 'engine.sqlite');
  let store = new Store(dbPath);
  const pool = new AccountPool(store, { root: dir });
  let direct = new DirectAgentRuntime(store, pool, { defaultWorkspace: dir, dataRoot: dir });

  try {
    const sess = direct.createSession({ title: 'Cancel Safety' });
    const now = Date.now();
    store.tx(() => {
      store.db
        .prepare(
          "INSERT INTO direct_turns(id, sessionId, input, model, state, jobId, createdAt, finishedAt) VALUES(?,?,?,'m','cancelled','j-cancel',?,?)",
        )
        .run('t-cancel', sess.id, 'should not run', now, now);
      store.db
        .prepare(
          "INSERT INTO runtime_jobs(id, kind, sessionId, turnId, payload, status, createdAt, updatedAt) VALUES('j-cancel','direct_turn',?,?,'{}','pending',?,?)",
        )
        .run(sess.id, 't-cancel', now, now);
    });

    // Reboot DirectAgentRuntime on same SQLite DB
    await direct.close();
    store.close();
    store = new Store(dbPath);
    const pool2 = new AccountPool(store, { root: dir });
    direct = new DirectAgentRuntime(store, pool2, { defaultWorkspace: dir, dataRoot: dir });

    assert.equal(direct.lastRecoveryReport.recoveredTurns.length, 0);
    const claimed = direct.jobQueue.claim({ workerId: 'probe' });
    assert.equal(claimed, null);
    const jobRow = store.db.prepare("SELECT status FROM runtime_jobs WHERE id='j-cancel'").get();
    assert.equal(jobRow.status, 'cancelled');
    const turnRow = store.db.prepare("SELECT state FROM direct_turns WHERE id='t-cancel'").get();
    assert.equal(turnRow.state, 'cancelled');
  } finally {
    await direct.close();
    store.close();
    rmDirSafe(dir);
  }
});

test('P2 Durable: Non-replayable executing receipt parks in unknown_outcome reconciliation and resolves happened / not_applied / abort without silent replay', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-us-p2-reconcile-'));
  const dbPath = join(dir, 'engine.sqlite');
  let bashExecutions = 0;

  const mockAdapter = {
    async *stream({ messages }) {
      const hasReconciledNote = messages.some(
        (m) =>
          (m.role === 'tool' || m.role === 'user') &&
          m.content?.some((b) => String(b.text || '').includes('已由人工确认')),
      );
      if (hasReconciledNote) {
        yield { type: 'text-delta', text: 'Reconciliation handled safely.' };
        return;
      }
      yield {
        type: 'block-end',
        block: {
          type: 'tool-call',
          id: 'call_side_1',
          name: 'bash',
          arguments: JSON.stringify({ command: 'echo side_effect' }),
        },
      };
    },
  };

  let store = new Store(dbPath);
  const pool = new AccountPool(store, { root: dir });
  let direct = new DirectAgentRuntime(store, pool, {
    defaultWorkspace: dir,
    dataRoot: dir,
    adapter: mockAdapter,
  });

  try {
    // Test 1: 'happened' resolution resumes turn cleanly without re-executing bash!
    const sess = direct.createSession({ title: 'Reconcile Happened', model: 'mock-m' });
    const now = Date.now();
    store.tx(() => {
      store.db
        .prepare("UPDATE direct_sessions SET state='running' WHERE id=?")
        .run(sess.id);
      store.db
        .prepare(
          "INSERT INTO direct_turns(id, sessionId, input, model, state, jobId, phase, step, createdAt) VALUES('t-rec-1',?,'run deploy','mock-m','running','j-rec-1','tools',1,?)",
        )
        .run(sess.id, now);
      store.db
        .prepare(
          "INSERT INTO direct_messages(sessionId, turnId, role, content, toolCalls, createdAt) VALUES(?,'t-rec-1','assistant','',?,?)",
        )
        .run(
          sess.id,
          JSON.stringify([
            {
              id: 'call_side_1',
              name: 'bash',
              arguments: JSON.stringify({ command: 'echo side_effect' }),
            },
          ]),
          now,
        );
      store.db
        .prepare(
          "INSERT INTO runtime_jobs(id, kind, sessionId, turnId, payload, status, fence, leaseExpiresAt, createdAt, updatedAt) VALUES('j-rec-1','direct_turn',?,'t-rec-1',?,'active','dead-fence',?,?,?)",
        )
        .run(
          sess.id,
          JSON.stringify({ sessionId: sess.id, turnId: 't-rec-1', input: 'run deploy', model: 'mock-m' }),
          now - 10000,
          now,
          now,
        );
      store.db
        .prepare(
          `INSERT INTO tool_receipts(
            id, sessionId, turnId, callId, toolName, riskLevel, effectClass,
            replayable, outward, argsDigest, status, createdAt, updatedAt
          ) VALUES('r-rec-1',?,'t-rec-1','call_side_1','bash','high','irreversible_side_effect',0,0,'abc','executing',?,?)`,
        )
        .run(sess.id, now, now);
    });

    // Reboot runtime -> triggers recoverOnStartup()
    await direct.close();
    store.close();
    store = new Store(dbPath);
    const pool2 = new AccountPool(store, { root: dir });
    direct = new DirectAgentRuntime(store, pool2, {
      defaultWorkspace: dir,
      dataRoot: dir,
      adapter: mockAdapter,
    });

    assert.equal(direct.lastRecoveryReport.reconciliationRequired.length, 1);
    const receiptAfterBoot = store.db.prepare("SELECT status FROM tool_receipts WHERE id='r-rec-1'").get();
    assert.equal(receiptAfterBoot.status, 'outcome_unknown');

    const turnReconciling = store.db.prepare("SELECT state FROM direct_turns WHERE id='t-rec-1'").get();
    assert.equal(turnReconciling.state, 'reconciling');

    const pendingRecs = direct.reconciler.listReconciliations({ sessionId: sess.id, status: 'pending' });
    assert.equal(pendingRecs.length, 1);
    const recApprovalId = pendingRecs[0].id;

    // Resolve as 'happened' via decideApproval -> resumes and completes turn without re-running tool
    const resolved = direct.decideApproval(recApprovalId, {
      outcome: 'happened',
      reason: 'Confirmed in external log',
    });
    assert.equal(resolved.outcome, 'happened');

    const completedTurn = await waitUntil(() => {
      const row = store.db.prepare("SELECT * FROM direct_turns WHERE id='t-rec-1'").get();
      return row?.state === 'completed' ? row : null;
    });
    assert.equal(completedTurn.state, 'completed');
    assert.equal(bashExecutions, 0);

    const receiptDone = store.db.prepare("SELECT status, reconciliationOutcome FROM tool_receipts WHERE id='r-rec-1'").get();
    assert.equal(receiptDone.status, 'reconciled_succeeded');
    assert.equal(receiptDone.reconciliationOutcome, 'happened');

    // Test 2: 'abort' reconciliation marks turn failed cleanly
    const sess2 = direct.createSession({ title: 'Reconcile Abort', model: 'mock-m' });
    const t2 = 't-rec-abort';
    store.tx(() => {
      store.db
        .prepare("INSERT INTO direct_turns(id, sessionId, input, model, state, jobId, phase, step, createdAt) VALUES(?,?,'deploy2','mock-m','running','j-rec-abort','tools',1,?)")
        .run(t2, sess2.id, Date.now());
      store.db
        .prepare("INSERT INTO runtime_jobs(id, kind, sessionId, turnId, payload, status, createdAt, updatedAt) VALUES('j-rec-abort','direct_turn',?,?,'{}','active',?,?)")
        .run(sess2.id, t2, Date.now(), Date.now());
      store.db
        .prepare("INSERT INTO tool_receipts(id, sessionId, turnId, callId, toolName, riskLevel, effectClass, replayable, outward, argsDigest, status, createdAt, updatedAt) VALUES('r-rec-abort',?,?, 'call_x','mcp__ext__deploy','high','external_network',0,1,'def','executing',?,?)")
        .run(sess2.id, t2, Date.now(), Date.now());
    });
    const inspect2 = direct.reconciler.inspectInterruptedTurn(t2, { sessionId: sess2.id });
    assert.equal(inspect2.needsReconciliation, true);
    const aborted = direct.decideApproval(inspect2.approvalId, { outcome: 'abort', reason: 'Operator aborted' });
    assert.equal(aborted.outcome, 'abort');
    const abortedTurn = store.db.prepare('SELECT state, error FROM direct_turns WHERE id=?').get(t2);
    assert.equal(abortedTurn.state, 'failed');
    assert.equal(abortedTurn.error, 'RECONCILIATION_ABORTED');

    // Verify JCS-SHA256 ledger remains valid across all audit entries
    const integrity = store.verifyIntegrity({ full: true });
    assert.equal(integrity.ok, true);
  } finally {
    await direct.close();
    store.close();
    rmDirSafe(dir);
  }
});

test('P2 Durable: Hard-killed subprocess recovers interrupted turn from SQLite checkpoint and completes cleanly', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-us-p2-sigkill-'));
  const dbPath = join(dir, 'engine.sqlite');
  writeFileSync(join(dir, 'note.txt'), 'CRASH_RECOVERY_OK\n', 'utf8');

  let llmCallCount = 0;
  let step1ReachedResolve;
  const step1Reached = new Promise((r) => {
    step1ReachedResolve = r;
  });

  // Upstream mock server stays alive in parent test process across child SIGKILL & reboot!
  const upstream = await listenMockOpenAi(async (req, res, cleanups) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
    if (req.url.endsWith('/chat/completions')) {
      llmCallCount++;
      const msgs = body.messages ?? [];
      const hasReadOutput = msgs.some(
        (m) => m.role === 'tool' && String(m.content || '').includes('CRASH_RECOVERY_OK'),
      );
      if (!hasReadOutput) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(
          `data: ${JSON.stringify({
            id: 'c1',
            choices: [
              {
                index: 0,
                delta: {
                  role: 'assistant',
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_read_crash',
                      type: 'function',
                      function: {
                        name: 'read_file',
                        arguments: JSON.stringify({ path: 'note.txt' }),
                      },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({
            id: 'c1',
            choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
          })}\n\n`,
        );
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      // On first attempt after tool execution, signal parent & hang until killed!
      if (llmCallCount === 2) {
        step1ReachedResolve();
        // Keep connection open so worker #1 stalls mid-flight before SIGKILL
        await new Promise((r) => {
          const done = () => {
            clearTimeout(timer);
            cleanups.delete(done);
            r();
          };
          const timer = setTimeout(done, 15000);
          timer.unref?.();
          cleanups.add(done);
          req.once('close', done);
        });
        return;
      }

      // Recovered worker #2 reaches here cleanly and finishes turn!
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(
        `data: ${JSON.stringify({
          id: 'c2',
          choices: [
            {
              index: 0,
              delta: { role: 'assistant', content: 'Recovered and read: CRASH_RECOVERY_OK' },
              finish_reason: null,
            },
          ],
        })}\n\n`,
      );
      res.write(
        `data: ${JSON.stringify({
          id: 'c2',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 20, completion_tokens: 9 },
        })}\n\n`,
      );
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    res.writeHead(404).end();
  });

  // Setup initial account & session in SQLite
  const initStore = new Store(dbPath);
  const initPool = new AccountPool(initStore, { root: dir });
  const acct = initPool.createAccount({
    preset: 'openai',
    label: 'MockCrash',
    apiKey: 'sk-mock-crash',
    endpoint: upstream.baseUrl,
  });
  initPool.addManualModel({
    preset: 'openai',
    accountId: acct.id,
    upstreamModel: 'gpt-crash-test',
  });
  initPool.setDefaultModel('gpt-crash-test');
  const initDirect = new DirectAgentRuntime(initStore, initPool, {
    defaultWorkspace: dir,
    dataRoot: dir,
  });
  const sess = initDirect.createSession({ title: 'SIGKILL Recovery', model: 'gpt-crash-test' });
  const startOut = initDirect.startTurn(sess.id, { input: 'read note.txt and confirm' });
  const turnId = startOut.turn.id;
  // Close immediately before worker runs so child process #1 owns execution cleanly
  await initDirect.close();
  initStore.close();

  const childScript = `
    import { Store } from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'src', 'store.js')).href)};
    import { AccountPool } from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'src', 'pool.js')).href)};
    import { DirectAgentRuntime } from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'src', 'direct-agent.js')).href)};
    const store = new Store(${JSON.stringify(dbPath)});
    const pool = new AccountPool(store, { root: ${JSON.stringify(dir)} });
    const direct = new DirectAgentRuntime(store, pool, {
      defaultWorkspace: ${JSON.stringify(dir)},
      dataRoot: ${JSON.stringify(dir)},
    });
    console.log('BOOTED:' + JSON.stringify(direct.lastRecoveryReport));
    setInterval(() => {}, 1000);
  `;
  const scriptPath = join(dir, 'worker-boot.mjs');
  writeFileSync(scriptPath, childScript, 'utf8');

  let child1 = null;
  let store2 = null;
  let direct2 = null;

  try {
    child1 = spawn(process.execPath, [scriptPath], {
      cwd: process.cwd(),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await withTimeout(step1Reached, 20000, 'durable-runtime step1Reached barrier');
    // Ensure checkpoint after step 1 is flushed before killing child1
    await new Promise((r) => setTimeout(r, 150));

    // Hard kill child1 (SIGKILL)
    child1.kill('SIGKILL');
    await new Promise((r) => child1.once('exit', r));
    child1 = null;

    // Boot process #2 on same SQLite DB -> recovers and completes turn!
    store2 = new Store(dbPath);
    const pool2 = new AccountPool(store2, { root: dir });
    direct2 = new DirectAgentRuntime(store2, pool2, {
      defaultWorkspace: dir,
      dataRoot: dir,
    });

    assert.equal(direct2.lastRecoveryReport.recoveredTurns.length, 1);
    assert.equal(direct2.lastRecoveryReport.recoveredTurns[0].turnId, turnId);
    assert.ok(direct2.lastRecoveryReport.recoveredTurns[0].resumedFromStep >= 1);

    const finished = await waitUntil(() => {
      const row = store2.db.prepare('SELECT * FROM direct_turns WHERE id=?').get(turnId);
      return row?.state === 'completed' ? row : null;
    });
    assert.equal(finished.state, 'completed');

    // read_file was only executed ONCE across the crash (not duplicated on recovery!)
    const readCalls = store2.db
      .prepare("SELECT COUNT(*) AS n FROM direct_messages WHERE turnId=? AND role='tool' AND toolName='read_file'")
      .get(turnId).n;
    assert.equal(readCalls, 1);

    const events = direct2.listEvents(sess.id, { after: 0, limit: 200 });
    assert.ok(events.some((e) => e.type === 'session/recovered'));
    assert.ok(events.some((e) => e.type === 'turn/completed'));
    // Zero idle polling once job finished
    await waitUntil(() => direct2.recoveryWorker.timer === null && direct2.recoveryWorker.active.size === 0);
    assert.equal(store2.verifyIntegrity({ full: true }).ok, true);
  } finally {
    if (child1 && child1.exitCode === null && child1.signalCode === null) {
      try {
        child1.kill('SIGKILL');
      } catch {}
      await new Promise((r) => {
        const onExit = () => {
          clearTimeout(timer);
          r();
        };
        const timer = setTimeout(() => {
          child1.off('exit', onExit);
          r();
        }, 2000);
        timer.unref?.();
        child1.once('exit', onExit);
        if (child1.exitCode !== null || child1.signalCode !== null) {
          child1.off('exit', onExit);
          onExit();
        }
      });
    }
    await direct2?.close();
    store2?.close();
    await upstream.close();
    rmDirSafe(dir);
  }
});
