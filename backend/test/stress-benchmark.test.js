import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import { rmDirSafe } from './fixtures.js';
import { Store, id as uuid } from '../src/store.js';
import { AccountPool } from '../src/pool.js';
import { DirectAgentRuntime } from '../src/direct-agent.js';
import { DurableJobQueue } from '../src/durable/job-queue.js';
import { CheckpointStore } from '../src/durable/checkpoint.js';
import { RecoveryWorker } from '../src/durable/recovery.js';
import { UnknownOutcomeReconciler } from '../src/durable/reconciliation.js';
import { ToolDispatcher } from '../src/tools/dispatcher.js';
import { ToolPermissionPolicy } from '../src/tools/policy.js';
import { defineTool, EFFECT_CLASSES, RISK_LEVELS } from '../src/tools/registry.js';
import { z } from 'zod';

class FastMockAdapter extends LlmAdapter {
  async *stream(options) {
    const prompt = options.messages.findLast((m) => m.role === 'user')?.content?.[0]?.text ?? '';
    yield { type: 'text-delta', index: 0, text: `fast-ack: ${prompt.slice(0, 24)}` };
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 6 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p));
  return Number(sorted[idx].toFixed(2));
}

test('P8 Stress Benchmark: 20 concurrent sessions, 50 tool dispatches, 4-worker queue contention, and 5 crash-recovery cycles', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-us-p8-stress-data-'));
  const workDir = mkdtempSync(join(tmpdir(), 'agent-us-p8-stress-work-'));
  writeFileSync(join(workDir, 'bench.txt'), 'benchmark baseline\n', 'utf8');

  const rssBefore = process.memoryUsage().rss;
  const heapBefore = process.memoryUsage().heapUsed;
  const store = new Store(join(dataDir, 'engine.sqlite'));
  const pool = new AccountPool(store, { root: dataDir });
  pool.setDefaultModel('mock-bench');
  const adapter = new FastMockAdapter();

  const direct = new DirectAgentRuntime(store, pool, {
    defaultWorkspace: workDir,
    dataRoot: dataDir,
    adapter,
  });

  try {
    // 1. 20 concurrent sessions
    const t0 = performance.now();
    const sessions = Array.from({ length: 20 }, (_, i) =>
      direct.createSession({ title: `bench-${i}`, workspaceRoot: workDir }),
    );
    const turnTimes = new Map();
    const turns = sessions.map((s, i) => {
      const start = performance.now();
      const { turn } = direct.startTurn(s.id, { input: `并发压力任务 #${i}` });
      turnTimes.set(turn.id, start);
      return { sid: s.id, tid: turn.id };
    });

    const latencies = [];
    const deadline = Date.now() + 15000;
    const pending = new Set(turns.map((x) => x.tid));
    while (pending.size > 0 && Date.now() < deadline) {
      for (const { sid, tid } of turns) {
        if (!pending.has(tid)) continue;
        const row = direct.listTurns(sid).find((r) => r.id === tid);
        if (row && row.state === 'completed') {
          pending.delete(tid);
          latencies.push(performance.now() - turnTimes.get(tid));
        } else if (row && row.state === 'failed') {
          assert.fail(`Concurrent session turn failed: ${row.error}`);
        }
      }
      if (pending.size > 0) await delay(15);
    }
    assert.equal(pending.size, 0, 'All 20 concurrent sessions must complete cleanly');
    const concElapsed = performance.now() - t0;
    latencies.sort((a, b) => a - b);

    // 2. 50 mixed tool dispatches via ToolDispatcher
    const dispatcher = new ToolDispatcher({
      store,
      eventRouter: direct.eventRouter,
      reconciler: direct.reconciler,
      policy: new ToolPermissionPolicy({ permissionMode: 'auto-safe' }),
    });
    const tools = [
      defineTool({
        name: 'bench_read',
        description: 'fast readonly',
        effectClass: EFFECT_CLASSES.READ_ONLY,
        riskLevel: RISK_LEVELS.LOW,
        replayable: true,
        zodSchema: z.object({ i: z.number() }),
        execute: async ({ i }) => `ok:${i}`,
      }),
      defineTool({
        name: 'bash',
        description: 'shell',
        effectClass: EFFECT_CLASSES.IRREVERSIBLE_SIDE_EFFECT,
        riskLevel: RISK_LEVELS.HIGH,
        replayable: false,
        requiresCommandCheck: true,
        zodSchema: z.object({ command: z.string() }),
        execute: async () => 'ran',
      }),
    ];
    const batchCalls = Array.from({ length: 50 }, (_, i) => ({
      id: `bench-tc-${i}`,
      name: i % 10 === 0 ? 'bash' : 'bench_read',
      arguments: i % 10 === 0 ? JSON.stringify({ command: 'rm -rf /' }) : JSON.stringify({ i }),
    }));
    const tTool0 = performance.now();
    const batchOut = await dispatcher.dispatchBatch({
      sessionId: sessions[0].id,
      turnId: turns[0].tid,
      toolCalls: batchCalls,
      tools,
      permissionMode: 'auto-safe',
    });
    const toolElapsed = performance.now() - tTool0;
    assert.equal(batchOut.length, 50);
    assert.equal(batchOut.filter((b) => !b.isError).length, 45);
    assert.equal(batchOut.filter((b) => b.isError).length, 5); // 5 hard-blocked rm -rf /
    const receiptsSaved = store.db
      .prepare('SELECT COUNT(*) AS n FROM tool_receipts WHERE turnId=?')
      .get(turns[0].tid).n;
    assert.equal(receiptsSaved, 50);

    // 3. 4 competing workers claiming 30 DurableJobQueue jobs
    const q = new DurableJobQueue(store);
    const jobIds = Array.from({ length: 30 }, (_, i) => {
      const job = q.enqueue({
        kind: 'stress_job',
        payload: { i },
        idempotencyKey: `stress:${i}:${Date.now()}`,
      });
      return job.id;
    });
    const executionCounts = new Map(jobIds.map((id) => [id, 0]));
    await Promise.all(
      Array.from({ length: 4 }, (_, wIdx) =>
        (async () => {
          const workerId = `stress-worker-${wIdx}`;
          while (true) {
            const job = q.claim({ workerId, kinds: ['stress_job'], leaseMs: 5000 });
            if (!job) break;
            executionCounts.set(job.id, (executionCounts.get(job.id) ?? 0) + 1);
            assert.equal(q.assertFence(job.id, job.fence), true);
            q.complete(job.id, job.fence);
          }
        })(),
      ),
    );
    for (const [, cnt] of executionCounts.entries()) {
      assert.equal(cnt, 1, 'Every contended queue job must execute exactly once');
    }

    // 4. 5 consecutive simulated crash-recovery cycles
    const ckStore = new CheckpointStore(store);
    const recReconciler = new UnknownOutcomeReconciler(store, direct.eventRouter);
    let recoveredCompleted = 0;
    for (let c = 0; c < 5; c++) {
      const cs = direct.createSession({ title: `crash-cycle-${c}`, workspaceRoot: workDir });
      const tid = uuid();
      const jid = uuid();
      const past = Date.now() - 10_000;
      store.tx(() => {
        store.db
          .prepare(
            "INSERT INTO direct_turns(id, sessionId, input, model, state, jobId, phase, step, createdAt) VALUES(?,?,?,'mock-bench','running',?,'inference',1,?)",
          )
          .run(tid, cs.id, `恢复测试 #${c}`, jid, past);
        store.db
          .prepare(
            `INSERT INTO runtime_jobs(
              id, kind, sessionId, turnId, payload, status, fence, workerId, leaseExpiresAt, attempts, maxAttempts, createdAt, updatedAt
            ) VALUES(?,'recovery_test',?,?,?,'active','old-fence','dead-worker',?,1,3,?,?)`,
          )
          .run(jid, cs.id, tid, JSON.stringify({ cycle: c }), past - 1000, past, past);
      });
      ckStore.save({ sessionId: cs.id, turnId: tid, step: 1, phase: 'inference', state: { c } });

      const rw = new RecoveryWorker({
        store,
        jobQueue: q,
        checkpointStore: ckStore,
        reconciler: recReconciler,
        eventRouter: direct.eventRouter,
        leaseMs: 5000,
        handlers: {
          recovery_test: async (job, ctx) => {
            assert.equal(ctx.checkpoint?.step, 1);
            recoveredCompleted++;
            store.tx(() => {
              store.db
                .prepare("UPDATE direct_turns SET state='completed', finishedAt=? WHERE id=?")
                .run(Date.now(), job.turnId);
            });
          },
        },
      });
      rw.start({ recover: true });
      await pollRecovery(store, tid);
      await rw.stop();
    }
    assert.equal(recoveredCompleted, 5);

    const rssAfter = process.memoryUsage().rss;
    const heapAfter = process.memoryUsage().heapUsed;
    const summary = {
      concurrentSessions: {
        count: 20,
        totalMs: Number(concElapsed.toFixed(1)),
        p50Ms: percentile(latencies, 0.5),
        p95Ms: percentile(latencies, 0.95),
      },
      toolDispatches: {
        total: 50,
        succeeded: 45,
        blocked: 5,
        elapsedMs: Number(toolElapsed.toFixed(1)),
      },
      queueContention: { workers: 4, jobs: 30, duplicateExecutions: 0 },
      crashRecoveryCycles: { cycles: 5, recovered: recoveredCompleted, ratePct: 100 },
      memoryDeltaMb: {
        rss: Number(((rssAfter - rssBefore) / (1024 * 1024)).toFixed(2)),
        heap: Number(((heapAfter - heapBefore) / (1024 * 1024)).toFixed(2)),
      },
    };
    console.log('[P8 BENCHMARK]', JSON.stringify(summary));
  } finally {
    await direct.close();
    store.close();
    rmDirSafe(dataDir);
    rmDirSafe(workDir);
  }
});

async function pollRecovery(store, turnId) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const r = store.db.prepare('SELECT state FROM direct_turns WHERE id=?').get(turnId);
    if (r?.state === 'completed') return;
    await delay(20);
  }
  throw new Error(`Timed out waiting for recovery turn ${turnId}`);
}
