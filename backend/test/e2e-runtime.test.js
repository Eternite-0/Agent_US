import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import { service } from '../src/service.js';
import { config } from '../src/providers.js';

class ScriptedAdapter extends LlmAdapter {
  async *stream(options) {
    const msgs = options.messages ?? [];
    const lastUser = msgs.findLast((m) => m.role === 'user')?.content?.[0]?.text ?? '';
    const hasTool = msgs.some((m) => m.role === 'tool');

    if (lastUser.includes('创建 e2e.txt') && !hasTool) {
      yield {
        type: 'block-end',
        index: 0,
        block: {
          type: 'tool-call',
          id: 'tc-e2e-write',
          name: 'write_file',
          arguments: JSON.stringify({ path: 'e2e.txt', content: 'hello e2e\n' }),
        },
      };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
      return;
    }

    yield { type: 'text-delta', index: 0, text: `OK: ${lastUser.slice(0, 50)}` };
    yield { type: 'usage', usage: { inputTokens: 16, outputTokens: 8 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}

async function pollUntil(fn, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const val = await fn();
    if (val) return val;
    await delay(25);
  }
  throw new Error('Timed out polling E2E condition');
}

test('P8 Full-Chain E2E: real HTTP/SSE -> tools -> receipts -> swarm -> compaction -> rewind -> schedules -> integrity', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-us-p8-e2e-data-'));
  const workDir = mkdtempSync(join(tmpdir(), 'agent-us-p8-e2e-work-'));
  const token = 'p8-e2e-bearer-token-1234567890abcd';
  const svc = await service({
    root: dataDir,
    token,
    configuration: config({ env: {} }),
    workspaceRoot: workDir,
  });

  const adapter = new ScriptedAdapter();
  svc.pool.setDefaultModel('mock-e2e');
  svc.pool.adapter = adapter;
  svc.directAgent.adapter = adapter;
  svc.directAgent.kernel.inference.adapter = adapter;

  const baseUrl = await svc.app.listen({ port: 0, host: '127.0.0.1' });
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
  const apiJson = async (method, path, body = undefined) => {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: body !== undefined ? headers : { Authorization: `Bearer ${token}` },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: res.status, json };
  };

  const sseAbort = new AbortController();
  const seenEvents = [];

  try {
    const h = await apiJson('GET', '/v1/health');
    assert.equal(h.status, 200);
    assert.equal(h.json.ok, true);

    const createdSess = await apiJson('POST', '/v1/sessions', {
      title: 'P8 E2E 验证会话',
      model: 'mock-e2e',
      workspaceRoot: workDir,
      permissionMode: 'auto-safe',
    });
    assert.equal(createdSess.status, 200);
    const sid = createdSess.json.id;

    // Connect live SSE stream over TCP
    const sseRes = await fetch(`${baseUrl}/v1/sessions/${sid}/stream`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
      signal: sseAbort.signal,
    });
    assert.equal(sseRes.status, 200);
    const reader = sseRes.body.getReader();
    const decoder = new TextDecoder();
    const sseLoop = (async () => {
      let buf = '';
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const frames = buf.split(/\r?\n\r?\n/);
          buf = frames.pop() ?? '';
          for (const frame of frames) {
            const m = /^data:\s*(.+)$/m.exec(frame);
            if (m) {
              try {
                seenEvents.push(JSON.parse(m[1]));
              } catch {
                // ignore
              }
            }
          }
        }
      } catch {
        // aborted on cleanup
      }
    })();

    // Turn 1: real write_file + tool receipt + SSE verification
    const t1 = await apiJson('POST', `/v1/sessions/${sid}/turns`, {
      input: '创建 e2e.txt 并确认。必须保留核心审计日志。',
    });
    assert.equal(t1.status, 200);
    const t1Id = t1.json.turn.id;

    await pollUntil(() => seenEvents.some((e) => e.type === 'turn/completed' && e.turnId === t1Id));
    assert.ok(seenEvents.some((e) => e.type === 'tool/call'));
    assert.ok(seenEvents.some((e) => e.type === 'tool/receipt'));
    assert.equal(existsSync(join(workDir, 'e2e.txt')), true);
    assert.equal(readFileSync(join(workDir, 'e2e.txt'), 'utf8'), 'hello e2e\n');

    const receipts = await apiJson('GET', `/v1/sessions/${sid}/receipts`);
    assert.equal(receipts.status, 200);
    assert.equal(receipts.json.items.length, 1);
    assert.equal(receipts.json.items[0].toolName, 'write_file');

    // Swarm DAG run + GET /v1/plans
    const swarmRes = await apiJson('POST', '/v1/swarm/runs', {
      sessionId: sid,
      goal: 'E2E 群体协同验证',
      maxConcurrency: 2,
      nodes: [
        { nodeKey: 'scan', taskType: 'research', objective: '扫描 e2e.txt', dependencies: [] },
        { nodeKey: 'audit', taskType: 'review', objective: '审计产物', dependencies: ['scan'] },
      ],
    });
    assert.equal(swarmRes.status, 201);
    assert.equal(swarmRes.json.status, 'completed');

    const plansRes = await apiJson('GET', '/v1/plans');
    assert.equal(plansRes.status, 200);
    assert.ok(plansRes.json.items.some((p) => p.kind === 'swarm_run' && p.id === swarmRes.json.runId));

    // Add extra turns to exceed compaction threshold (> 6 messages), then non-destructive compact
    for (const prompt of ['第二轮汇报', '第三轮检查', '第四轮确认']) {
      const tn = await apiJson('POST', `/v1/sessions/${sid}/turns`, { input: prompt });
      await pollUntil(() =>
        seenEvents.some((e) => e.type === 'turn/completed' && e.turnId === tn.json.turn.id),
      );
    }
    const rawMsgCount = svc.store.db
      .prepare('SELECT COUNT(*) AS n FROM direct_messages WHERE sessionId=?')
      .get(sid).n;
    const compactRes = await apiJson('POST', `/v1/sessions/${sid}/compact`, {});
    assert.equal(compactRes.status, 200);
    assert.equal(compactRes.json.compacted, true);
    assert.equal(
      svc.store.db.prepare('SELECT COUNT(*) AS n FROM direct_messages WHERE sessionId=?').get(sid).n,
      rawMsgCount,
      'Non-destructive compaction must preserve every direct_messages row',
    );
    const compList = await apiJson('GET', `/v1/sessions/${sid}/compactions`);
    assert.equal(compList.status, 200);
    assert.equal(compList.json.items.length, 1);

    // Deterministic rewind to Turn 1 restores pre-mutation workspace (removes e2e.txt)
    const rewindRes = await apiJson('POST', `/v1/sessions/${sid}/rewind`, {
      turnId: t1Id,
      scope: 'both',
    });
    assert.equal(rewindRes.status, 200);
    assert.equal(rewindRes.json.ok, true);
    assert.equal(existsSync(join(workDir, 'e2e.txt')), false);

    // Schedules + Integrity + Overview
    const sched = await apiJson('POST', '/v1/schedules', {
      name: 'E2E 巡检',
      prompt: '输出健康检查通过',
      scheduleKind: 'daily',
      scheduleExpr: '08:00',
    });
    assert.equal(sched.status, 201);
    const runSched = await apiJson('POST', `/v1/schedules/${sched.json.id}/run`, {});
    assert.equal(runSched.status, 200);
    await apiJson('DELETE', `/v1/schedules/${sched.json.id}`);

    const integ = await apiJson('GET', '/v1/audit/integrity');
    assert.equal(integ.status, 200);
    assert.equal(integ.json.ok, true);

    const ov = await apiJson('GET', '/v1/runtime/overview');
    assert.equal(ov.status, 200);
    assert.equal(ov.json.ok, true);

    sseAbort.abort();
    await sseLoop;
  } finally {
    sseAbort.abort();
    await svc.close();
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
    try {
      rmSync(workDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
    } catch {
      // ignore transient Windows directory handle lock in temp cleanup
    }
  }
});
