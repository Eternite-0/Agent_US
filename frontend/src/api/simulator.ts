import type {
  Approval,
  Artifact,
  Assignment,
  EventEnvelope,
  Evidence,
  MemoryItem,
  ModelSpec,
  Project,
  ProviderAccount,
  ProviderInfo,
  ProviderPresetCatalog,
  ProvidersHealth,
  SessionHistoryItem,
  SessionRecord,
  Submission,
  Task,
  TaskBundle,
  UsageItem,
  GitStatus,
  Worker,
} from '../types/backend';
import { encodeUtf8Base64 } from '../utils/diff';
import type { AgentBackendClient } from './client';
import { ApiError } from './client';

function uid(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
}

const SAMPLE_BEFORE_QUEUE = `export class TaskQueue {
  constructor() {
    this.items = [];
  }
  push(job) {
    this.items.push(job);
  }
  pop() {
    return this.items.shift();
  }
}
`;

const SAMPLE_AFTER_QUEUE = `export class TaskQueue {
  constructor(maxConcurrency = 4) {
    this.heap = [];
    this.readyByAccount = new Map();
    this.maxConcurrency = maxConcurrency;
  }

  push(job) {
    this.heap.push(job);
    this._siftUp(this.heap.length - 1);
    const bucket = this.readyByAccount.get(job.accountId) ?? [];
    bucket.push(job.id);
    this.readyByAccount.set(job.accountId, bucket);
  }

  pop() {
    if (!this.heap.length) return null;
    const top = this.heap[0];
    const last = this.heap.pop();
    if (this.heap.length) {
      this.heap[0] = last;
      this._siftDown(0);
    }
    return top;
  }

  _siftUp(i) {
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.heap[p].priority <= this.heap[i].priority) break;
      [this.heap[p], this.heap[i]] = [this.heap[i], this.heap[p]];
      i = p;
    }
  }

  _siftDown(i) {
    const n = this.heap.length;
    while (true) {
      let best = i;
      const l = i * 2 + 1;
      const r = i * 2 + 2;
      if (l < n && this.heap[l].priority < this.heap[best].priority) best = l;
      if (r < n && this.heap[r].priority < this.heap[best].priority) best = r;
      if (best === i) break;
      [this.heap[i], this.heap[best]] = [this.heap[best], this.heap[i]];
      i = best;
    }
  }
}
`;

const SAMPLE_TEST_FILE = `import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskQueue } from '../src/queue.js';

test('min-heap respects priority and lease ordering', () => {
  const q = new TaskQueue(4);
  q.push({ id: 'j3', accountId: 'a1', priority: 30 });
  q.push({ id: 'j1', accountId: 'a1', priority: 10 });
  q.push({ id: 'j2', accountId: 'a2', priority: 20 });

  assert.equal(q.pop().id, 'j1');
  assert.equal(q.pop().id, 'j2');
  assert.equal(q.pop().id, 'j3');
});
`;

const SAMPLE_PERF_MD = `# Performance Benchmark Report

| 瓶颈 | 改动 | 实测 before -> after |
| --- | --- | --- |
| 队列调度扫描 | 最小堆 + 账号 ready 队列 | 325 -> 453.9 任务/秒 |
| 租约续期心跳 | 2s fencing token 批更新 | P99 18.4ms -> 4.1ms |
| WAL 快照刷新 | 增量 revision 写入 | 56 项回归 100% 通过 |
`;

const SAMPLE_ROUTER_BEFORE = `export function pickModel(models, role) {
  return models[0];
}
`;

const SAMPLE_ROUTER_AFTER = `export function pickModel(models, role, complexity = 'medium', attempt = 0) {
  const weights = {
    Researcher: 'research',
    Planner: 'design',
    Coder: 'coding',
    Reviewer: 'design',
    Tester: 'coding',
  };
  const score = (m) =>
    4 * m[weights[role]] +
    (complexity === 'simple' ? 2 : 0.5) * m.speed -
    Math.log1p(m.inputRate + m.outputRate) / 3;
  const ranked = [...models].sort((a, b) => score(b) - score(a));
  return ranked[attempt % ranked.length];
}
`;

export class SimulatorClient implements AgentBackendClient {
  readonly isDemo = true;
  private seq = 100;
  private listeners = new Set<(ev: EventEnvelope) => void>();

  private projects: Project[] = [];
  private tasks = new Map<string, Task>();
  private assignments = new Map<string, Assignment[]>();
  private workers = new Map<string, Worker[]>();
  private sessions = new Map<string, SessionRecord[]>();
  private histories = new Map<string, SessionHistoryItem[]>();
  private approvals = new Map<string, Approval[]>();
  private evidence = new Map<string, Evidence[]>();
  private artifacts = new Map<string, Artifact[]>();
  private usage: UsageItem[] = [];
  private memory: MemoryItem[] = [];
  private events: EventEnvelope[] = [];
  private pendingResolvers = new Map<string, (decision: 'approve' | 'deny') => void>();

  private models: ModelSpec[] = [
    {
      provider: 'deepseek',
      model: 'deepseek-reasoner',
      design: 0.94,
      coding: 0.95,
      math: 0.96,
      research: 0.91,
      speed: 0.72,
      context: 128000,
      tools: true,
      inputRate: 0.55,
      outputRate: 2.19,
    },
    {
      provider: 'deepseek',
      model: 'deepseek-chat',
      design: 0.86,
      coding: 0.9,
      math: 0.85,
      research: 0.88,
      speed: 0.93,
      context: 128000,
      tools: true,
      inputRate: 0.27,
      outputRate: 1.1,
    },
    {
      provider: 'openai',
      model: 'gpt-5.4-codex',
      design: 0.96,
      coding: 0.98,
      math: 0.94,
      research: 0.93,
      speed: 0.84,
      context: 200000,
      tools: true,
      inputRate: 2.5,
      outputRate: 10.0,
    },
  ];

  private providers: ProviderInfo[] = [
    {
      id: 'deepseek',
      configured: true,
      discovery: { ok: true, ids: ['deepseek-reasoner', 'deepseek-chat'] },
      magpieReady: true,
    },
    {
      id: 'openai',
      configured: true,
      discovery: { ok: true, ids: ['gpt-5.4-codex', 'gpt-5.4-mini'] },
      magpieReady: true,
    },
  ];

  constructor() {
    this.seed();
  }

  private emit(type: string, projectId: string | null, taskId: string | null, payload: Record<string, unknown> = {}) {
    const ev: EventEnvelope = {
      seq: ++this.seq,
      timestamp: Date.now(),
      type,
      projectId,
      taskId,
      payload,
    };
    this.events.push(ev);
    for (const fn of this.listeners) fn(ev);
  }

  private seed() {
    const now = Date.now();
    const p1: Project = { id: 'proj-agent-us', version: 1, projectId: null, taskId: null, name: 'Agent_US' };
    const p2: Project = { id: 'proj-chaoxing', version: 1, projectId: null, taskId: null, name: 'chaoxing-wx' };
    const p3: Project = { id: 'proj-forge', version: 1, projectId: null, taskId: null, name: 'FORGE' };
    this.projects = [p1, p2, p3];

    // Task 1: Completed full DAG task with diffs, command cards, review verdict, subagents
    const t1Id = 'task-perf-opt';
    const t1: Task = {
      id: t1Id,
      version: 4,
      projectId: p1.id,
      taskId: null,
      createdAt: now - 1000 * 60 * 18,
      input: '优化 Task Engine 调度队列与多模型路由选择，补齐单测并输出性能压测报告。',
      status: 'completed',
      budget: { maxSteps: 12, maxDurationSeconds: 1800, maxCostUSD: 2.0 },
      plan: {
        type: 'coding',
        complexity: 'complex',
        risk: 'medium',
        nodes: [
          {
            key: 'optimize_queue',
            role: 'Coder',
            objective: '将 TaskQueue 线性扫描替换为最小堆与账号级 ready 队列',
            acceptance: '队列入队/出队复杂度降至 O(log N) 且保持租约语义',
            dependencies: [],
            requiredFiles: ['src/queue.js'],
          },
          {
            key: 'update_router',
            role: 'Coder',
            objective: '按角色权重、复杂度与成本对数惩罚排序候选模型',
            acceptance: '支持失败重试轮转候选模型且单测全部通过',
            dependencies: [],
            requiredFiles: ['src/router.js'],
          },
          {
            key: 'verify_bench',
            role: 'Tester',
            objective: '补充最小堆单元测试并执行全量回归与吞吐压测',
            acceptance: '所有测试 100% 通过并生成 PERFORMANCE.md',
            dependencies: ['optimize_queue', 'update_router'],
            requiredFiles: ['test/queue.test.js', 'PERFORMANCE.md'],
          },
        ],
      },
      verdict: {
        accepted: true,
        reason: '所有 3 个工作节点交付物与退出码 0 执行证据均已核验，性能提升与回归结果真实有效。',
      },
    };
    this.tasks.set(t1Id, t1);

    const a1: Assignment = {
      id: 'asgn-q',
      version: 3,
      projectId: p1.id,
      taskId: t1Id,
      ...t1.plan!.nodes[0],
      status: 'done',
      workerId: 'wrk-coder-1',
    };
    const a2: Assignment = {
      id: 'asgn-r',
      version: 3,
      projectId: p1.id,
      taskId: t1Id,
      ...t1.plan!.nodes[1],
      status: 'done',
      workerId: 'wrk-coder-2',
    };
    const a3: Assignment = {
      id: 'asgn-t',
      version: 3,
      projectId: p1.id,
      taskId: t1Id,
      ...t1.plan!.nodes[2],
      status: 'done',
      workerId: 'wrk-tester-1',
    };
    this.assignments.set(t1Id, [a1, a2, a3]);

    const wPlan: Worker = {
      id: 'wrk-plan-1',
      version: 2,
      projectId: p1.id,
      taskId: t1Id,
      role: 'Planner',
      jobId: 'job-p1',
      model: 'deepseek-reasoner',
      provider: 'deepseek',
      assignmentId: null,
      status: 'done',
      attempt: 1,
    };
    const w1: Worker = {
      id: 'wrk-coder-1',
      version: 2,
      projectId: p1.id,
      taskId: t1Id,
      role: 'Coder',
      jobId: 'job-c1',
      model: 'gpt-5.4-codex',
      provider: 'openai',
      assignmentId: a1.id,
      status: 'done',
      attempt: 1,
    };
    const w2: Worker = {
      id: 'wrk-coder-2',
      version: 2,
      projectId: p1.id,
      taskId: t1Id,
      role: 'Coder',
      jobId: 'job-c2',
      model: 'gpt-5.4-codex',
      provider: 'openai',
      assignmentId: a2.id,
      status: 'done',
      attempt: 1,
    };
    const w3: Worker = {
      id: 'wrk-tester-1',
      version: 2,
      projectId: p1.id,
      taskId: t1Id,
      role: 'Tester',
      jobId: 'job-t1',
      model: 'deepseek-chat',
      provider: 'deepseek',
      assignmentId: a3.id,
      status: 'done',
      attempt: 1,
    };
    const wRev: Worker = {
      id: 'wrk-rev-1',
      version: 2,
      projectId: p1.id,
      taskId: t1Id,
      role: 'Reviewer',
      jobId: 'job-r1',
      model: 'deepseek-reasoner',
      provider: 'deepseek',
      assignmentId: null,
      status: 'done',
      attempt: 1,
    };
    this.workers.set(t1Id, [wPlan, w1, w2, w3, wRev]);

    const sessions: SessionRecord[] = [
      { id: 'sess-p1', version: 2, projectId: p1.id, taskId: t1Id, workerId: wPlan.id, assignmentId: null, role: 'Planner', status: 'done' },
      { id: 'sess-c1', version: 2, projectId: p1.id, taskId: t1Id, workerId: w1.id, assignmentId: a1.id, role: 'Coder', status: 'done' },
      { id: 'sess-c2', version: 2, projectId: p1.id, taskId: t1Id, workerId: w2.id, assignmentId: a2.id, role: 'Coder', status: 'done' },
      { id: 'sess-t1', version: 2, projectId: p1.id, taskId: t1Id, workerId: w3.id, assignmentId: a3.id, role: 'Tester', status: 'done' },
      { id: 'sess-r1', version: 2, projectId: p1.id, taskId: t1Id, workerId: wRev.id, assignmentId: null, role: 'Reviewer', status: 'done' },
    ];
    this.sessions.set(t1Id, sessions);

    this.histories.set('sess-c1', [
      { cursor: 1, sessionId: 'sess-c1', type: 'turn/start', sequence: 1 },
      { cursor: 2, sessionId: 'sess-c1', type: 'tool/call', sequence: 2, name: 'read_file', callId: 'call_read_q' },
      { cursor: 3, sessionId: 'sess-c1', type: 'tool/result', sequence: 3 },
      { cursor: 4, sessionId: 'sess-c1', type: 'tool/call', sequence: 4, name: 'write_file', callId: 'call_write_q' },
      { cursor: 5, sessionId: 'sess-c1', type: 'tool/result', sequence: 5 },
      {
        cursor: 6,
        sessionId: 'sess-c1',
        type: 'assistant/message',
        sequence: 6,
        text: '已完成 `src/queue.js` 最小堆与账号级 ready 队列重构，消除线性队列扫描瓶颈。',
      },
      { cursor: 7, sessionId: 'sess-c1', type: 'turn/end', sequence: 7 },
    ]);
    this.histories.set('sess-t1', [
      { cursor: 8, sessionId: 'sess-t1', type: 'turn/start', sequence: 1 },
      { cursor: 9, sessionId: 'sess-t1', type: 'tool/call', sequence: 2, name: 'shell', callId: 'call_test' },
      { cursor: 10, sessionId: 'sess-t1', type: 'tool/result', sequence: 3 },
      {
        cursor: 11,
        sessionId: 'sess-t1',
        type: 'assistant/message',
        sequence: 4,
        text: '全部 56 项回归测试通过，吞吐量从 325 提升至 **453.9 任务/秒**。详细数据见 `PERFORMANCE.md`。',
      },
      { cursor: 12, sessionId: 'sess-t1', type: 'turn/end', sequence: 5 },
    ]);

    this.approvals.set(t1Id, [
      {
        id: 'appr-1',
        version: 2,
        projectId: p1.id,
        taskId: t1Id,
        workerId: w1.id,
        assignmentId: a1.id,
        status: 'consumed',
        tool: 'write_file',
        action: { path: 'src/queue.js', text: SAMPLE_AFTER_QUEUE },
        digest: 'a94f2d0c81b3e4f9120a5c887d1a4b66',
        expires: now - 1000 * 60 * 10,
      },
      {
        id: 'appr-2',
        version: 2,
        projectId: p1.id,
        taskId: t1Id,
        workerId: w3.id,
        assignmentId: a3.id,
        status: 'consumed',
        tool: 'shell',
        action: { argv: ['node', '--test', 'test/*.test.js'] },
        digest: 'b72c9e11f34098ac5512de9081ff2231',
        expires: now - 1000 * 60 * 9,
      },
    ]);

    this.evidence.set(t1Id, [
      {
        id: 'ev-1',
        version: 1,
        projectId: p1.id,
        taskId: t1Id,
        status: 'finished',
        tool: 'read_file',
        workerId: w1.id,
        assignmentId: a1.id,
        path: 'src/queue.js',
        digest: 'd11e2a3b',
      },
      {
        id: 'ev-2',
        version: 2,
        projectId: p1.id,
        taskId: t1Id,
        status: 'finished',
        tool: 'write_file',
        workerId: w1.id,
        assignmentId: a1.id,
        approvalId: 'appr-1',
        digest: 'a94f2d0c81b3e4f9',
        exitCode: 0,
        stdout: 'Wrote src/queue.js (1084 bytes)\n',
        stderr: '',
        changes: [
          {
            path: 'src/queue.js',
            before: encodeUtf8Base64(SAMPLE_BEFORE_QUEUE),
            after: encodeUtf8Base64(SAMPLE_AFTER_QUEUE),
          },
        ],
      },
      {
        id: 'ev-3',
        version: 2,
        projectId: p1.id,
        taskId: t1Id,
        status: 'finished',
        tool: 'write_file',
        workerId: w2.id,
        assignmentId: a2.id,
        digest: 'f402a190bc3e8712',
        exitCode: 0,
        stdout: 'Wrote src/router.js (640 bytes)\n',
        stderr: '',
        changes: [
          {
            path: 'src/router.js',
            before: encodeUtf8Base64(SAMPLE_ROUTER_BEFORE),
            after: encodeUtf8Base64(SAMPLE_ROUTER_AFTER),
          },
        ],
      },
      {
        id: 'ev-4',
        version: 2,
        projectId: p1.id,
        taskId: t1Id,
        status: 'finished',
        tool: 'shell',
        workerId: w3.id,
        assignmentId: a3.id,
        approvalId: 'appr-2',
        digest: 'b72c9e11f34098ac',
        exitCode: 0,
        stdout: `✔ min-heap respects priority and lease ordering (2.41ms)\n✔ router ranks models by role weights and cost (1.18ms)\n✔ durable WAL lease recovery under concurrent claim (14.62ms)\nℹ tests 56\nℹ suites 9\nℹ pass 56\nℹ fail 0\nℹ duration_ms 184.22\n`,
        stderr: '',
        changes: [
          { path: 'test/queue.test.js', before: null, after: encodeUtf8Base64(SAMPLE_TEST_FILE) },
          { path: 'PERFORMANCE.md', before: null, after: encodeUtf8Base64(SAMPLE_PERF_MD) },
        ],
      },
    ]);

    this.artifacts.set(t1Id, [
      {
        id: 'art-1',
        version: 1,
        projectId: p1.id,
        taskId: t1Id,
        key: 'verify_bench',
        workerId: w3.id,
        assignmentId: a3.id,
        published: true,
        text: `已完成队列调度与模型路由优化，并补齐单元测试与压测报告。\n\n| 瓶颈 | 改动 | 实测 before → after |\n| --- | --- | --- |\n| 队列调度扫描 | 最小堆 + 账号 ready 队列 | 325 → **453.9 任务/秒** |\n| 租约续期心跳 | 2s fencing token 批更新 | P99 18.4ms → **4.1ms** |\n| 模型路由评分 | 角色权重 + 成本对数惩罚 | 56 项回归 **100% 通过** |\n\n所有产物均在无网络隔离 Worker 容器中验证通过，详细数据与复现命令见 [PERFORMANCE.md](file://PERFORMANCE.md)。`,
        files: {
          'src/queue.js': encodeUtf8Base64(SAMPLE_AFTER_QUEUE),
          'src/router.js': encodeUtf8Base64(SAMPLE_ROUTER_AFTER),
          'test/queue.test.js': encodeUtf8Base64(SAMPLE_TEST_FILE),
          'PERFORMANCE.md': encodeUtf8Base64(SAMPLE_PERF_MD),
        },
      },
    ]);

    // Task 2: Active running task with a LIVE pending approval gate!
    const t2Id = 'task-live-approval';
    const t2: Task = {
      id: t2Id,
      version: 2,
      projectId: p1.id,
      taskId: null,
      createdAt: now - 1000 * 60 * 3,
      input: '为审批网关添加过期自动吊销机制，并在沙箱内运行安全集成测试验证 409 幂等拒绝。',
      status: 'running',
      budget: { maxSteps: 10, maxDurationSeconds: 1200, maxCostUSD: 1.5 },
      plan: {
        type: 'security',
        complexity: 'medium',
        risk: 'high',
        nodes: [
          {
            key: 'patch_gate',
            role: 'Coder',
            objective: '在 tools.js 中为审批消费增加过期校验与 fencing token 事务锁',
            acceptance: '过期审批无法被消费，重复裁决返回 409 APPROVAL_INACTIVE',
            dependencies: [],
            requiredFiles: ['src/tools.js'],
          },
          {
            key: 'security_test',
            role: 'Tester',
            objective: '运行 security.test.js 验证竞态消费与越权路径拒绝',
            acceptance: 'security.test.js 全部通过，退出码 0',
            dependencies: ['patch_gate'],
          },
        ],
      },
    };
    this.tasks.set(t2Id, t2);
    this.assignments.set(t2Id, [
      {
        id: 'asgn-sec-1',
        version: 2,
        projectId: p1.id,
        taskId: t2Id,
        ...t2.plan!.nodes[0],
        status: 'running',
        workerId: 'wrk-sec-coder',
      },
      {
        id: 'asgn-sec-2',
        version: 1,
        projectId: p1.id,
        taskId: t2Id,
        ...t2.plan!.nodes[1],
        status: 'waiting',
      },
    ]);
    this.workers.set(t2Id, [
      {
        id: 'wrk-sec-plan',
        version: 2,
        projectId: p1.id,
        taskId: t2Id,
        role: 'Planner',
        jobId: 'job-sp',
        model: 'deepseek-reasoner',
        provider: 'deepseek',
        assignmentId: null,
        status: 'done',
        attempt: 1,
      },
      {
        id: 'wrk-sec-coder',
        version: 1,
        projectId: p1.id,
        taskId: t2Id,
        role: 'Coder',
        jobId: 'job-sc',
        model: 'gpt-5.4-codex',
        provider: 'openai',
        assignmentId: 'asgn-sec-1',
        status: 'running',
        attempt: 1,
      },
    ]);
    this.sessions.set(t2Id, [
      {
        id: 'sess-sec-1',
        version: 1,
        projectId: p1.id,
        taskId: t2Id,
        workerId: 'wrk-sec-coder',
        assignmentId: 'asgn-sec-1',
        role: 'Coder',
        status: 'running',
      },
    ]);
    this.histories.set('sess-sec-1', [
      { cursor: 20, sessionId: 'sess-sec-1', type: 'turn/start', sequence: 1 },
      { cursor: 21, sessionId: 'sess-sec-1', type: 'tool/call', sequence: 2, name: 'read_file', callId: 'c_sec_1' },
      { cursor: 22, sessionId: 'sess-sec-1', type: 'tool/result', sequence: 3 },
      { cursor: 23, sessionId: 'sess-sec-1', type: 'tool/call', sequence: 4, name: 'shell', callId: 'c_sec_2' },
    ]);
    this.evidence.set(t2Id, [
      {
        id: 'ev-sec-read',
        version: 1,
        projectId: p1.id,
        taskId: t2Id,
        status: 'finished',
        tool: 'read_file',
        workerId: 'wrk-sec-coder',
        assignmentId: 'asgn-sec-1',
        path: 'src/tools.js',
        digest: 'e4810ca219f8d3b0',
      },
    ]);
    const pendingApproval: Approval = {
      id: 'appr-live-pending',
      version: 1,
      projectId: p1.id,
      taskId: t2Id,
      workerId: 'wrk-sec-coder',
      assignmentId: 'asgn-sec-1',
      status: 'pending',
      tool: 'shell',
      action: { argv: ['node', '--test', 'test/security.test.js'] },
      digest: '84c91a7ef012bc9844da01b7712e90cf',
      expires: now + 1000 * 60 * 30,
    };
    this.approvals.set(t2Id, [pendingApproval]);
    this.artifacts.set(t2Id, []);

    // Task 3 in chaoxing-wx project
    const t3Id = 'task-ui-polish';
    const t3: Task = {
      id: t3Id,
      version: 3,
      projectId: p2.id,
      taskId: null,
      createdAt: now - 1000 * 60 * 140,
      input: '重构前端设计语言，保留现有配色，统一卡片圆角与悬停微动效。',
      status: 'completed',
      plan: {
        type: 'frontend',
        complexity: 'simple',
        risk: 'low',
        nodes: [
          {
            key: 'refactor_tokens',
            role: 'Coder',
            objective: '整理语义 CSS 变量并替换组件散落硬编码色值',
            acceptance: '构建零错误，明暗主题均一致',
            dependencies: [],
          },
        ],
      },
      verdict: { accepted: true, reason: '样式构建与视觉回归全部通过。' },
    };
    this.tasks.set(t3Id, t3);
    this.assignments.set(t3Id, [
      { id: 'asgn-ui-1', version: 2, projectId: p2.id, taskId: t3Id, ...t3.plan!.nodes[0], status: 'done', workerId: 'wrk-ui-1' },
    ]);
    this.workers.set(t3Id, [
      { id: 'wrk-ui-1', version: 2, projectId: p2.id, taskId: t3Id, role: 'Coder', jobId: 'job-ui-1', model: 'gpt-5.4-codex', provider: 'openai', assignmentId: 'asgn-ui-1', status: 'done', attempt: 1 },
    ]);
    this.sessions.set(t3Id, []);
    this.approvals.set(t3Id, []);
    this.evidence.set(t3Id, []);
    this.artifacts.set(t3Id, [
      {
        id: 'art-ui-1',
        version: 1,
        projectId: p2.id,
        taskId: t3Id,
        key: 'refactor_tokens',
        assignmentId: 'asgn-ui-1',
        published: true,
        text: '已完成前端重构，统一了排版、细线边框、20px 气泡与 0.15s `cubic-bezier(0, 0, .2, 1)` 轻量过渡动效。静态检查与构建全部通过。',
        files: {},
      },
    ]);

    this.usage = [
      {
        id: 'usg-1',
        version: 1,
        projectId: p1.id,
        taskId: t1Id,
        sessionId: 'sess-p1',
        provider: 'deepseek',
        model: 'deepseek-reasoner',
        inputTokens: 4280,
        outputTokens: 1120,
        estimatedUSD: 0.0048,
      },
      {
        id: 'usg-2',
        version: 1,
        projectId: p1.id,
        taskId: t1Id,
        sessionId: 'sess-c1',
        provider: 'openai',
        model: 'gpt-5.4-codex',
        inputTokens: 12400,
        outputTokens: 3820,
        estimatedUSD: 0.0692,
      },
      {
        id: 'usg-3',
        version: 1,
        projectId: p1.id,
        taskId: t1Id,
        sessionId: 'sess-t1',
        provider: 'deepseek',
        model: 'deepseek-chat',
        inputTokens: 6150,
        outputTokens: 1640,
        estimatedUSD: 0.0035,
      },
    ];

    this.memory = [
      {
        id: 'mem-1',
        version: 1,
        projectId: p1.id,
        taskId: t1Id,
        summary: JSON.stringify({
          task: t1.input,
          outcome: t1.verdict?.reason,
          outputs: ['art-1'],
        }),
      },
      {
        id: 'mem-2',
        version: 1,
        projectId: p2.id,
        taskId: t3Id,
        summary: JSON.stringify({
          task: t3.input,
          outcome: t3.verdict?.reason,
          outputs: ['art-ui-1'],
        }),
      },
    ];
  }

  async health(): Promise<{ ok: boolean }> {
    return { ok: true };
  }

  async listProjects(): Promise<Project[]> {
    return [...this.projects];
  }

  async createProject(name: string): Promise<Project> {
    const trimmed = name.trim();
    if (!trimmed) throw new ApiError(400, 'INVALID_REQUEST');
    const p: Project = { id: uid('proj'), version: 1, projectId: null, taskId: null, name: trimmed };
    this.projects.push(p);
    this.emit('projects.created', p.id, null, { id: p.id });
    return p;
  }

  async renameProject(id: string, name: string, version: number): Promise<Project> {
    const idx = this.projects.findIndex((p) => p.id === id);
    if (idx < 0) throw new ApiError(404, 'NOT_FOUND');
    const cur = this.projects[idx];
    if (cur.version !== version) throw new ApiError(409, 'STALE_VERSION');
    const next = { ...cur, name: name.trim(), version: cur.version + 1 };
    this.projects[idx] = next;
    this.emit('projects.updated', next.id, null, { id: next.id, version: next.version });
    return next;
  }

  async listTasks(params?: { projectId?: string }): Promise<Task[]> {
    let list = [...this.tasks.values()];
    if (params?.projectId) list = list.filter((t) => t.projectId === params.projectId);
    return list.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  }

  async getTask(id: string): Promise<Task> {
    const t = this.tasks.get(id);
    if (!t) throw new ApiError(404, 'NOT_FOUND');
    return { ...t };
  }

  async submitTask(submission: Submission): Promise<Task> {
    const id = uid('task');
    const task: Task = {
      id,
      version: 1,
      projectId: submission.projectId,
      taskId: null,
      createdAt: Date.now(),
      input: submission.input,
      status: 'planning',
      budget: submission.budget,
      files: submission.files,
    };
    this.tasks.set(id, task);
    this.assignments.set(id, []);
    this.workers.set(id, []);
    this.sessions.set(id, []);
    this.approvals.set(id, []);
    this.evidence.set(id, []);
    this.artifacts.set(id, []);
    this.emit('tasks.created', task.projectId, id, { id });
    void this.runSimulatedLifecycle(id);
    return { ...task };
  }

  private async runSimulatedLifecycle(taskId: string) {
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const checkAlive = () => {
      const t = this.tasks.get(taskId);
      return t && ['planning', 'running', 'reviewing'].includes(t.status);
    };

    await wait(900);
    if (!checkAlive()) return;

    const task = this.tasks.get(taskId)!;
    const plan = {
      type: 'coding',
      complexity: 'medium' as const,
      risk: 'low' as const,
      nodes: [
        {
          key: 'implement',
          role: 'Coder' as const,
          objective: `实现请求：${task.input.slice(0, 60)}`,
          acceptance: '产出可运行代码与变更文件，退出码 0',
          dependencies: [],
          requiredFiles: ['src/solution.ts'],
        },
        {
          key: 'verify',
          role: 'Tester' as const,
          objective: '在无网络沙箱容器内运行验证测试',
          acceptance: '所有断言通过且无未处理异常',
          dependencies: ['implement'],
        },
      ],
    };

    const updatedPlan: Task = { ...task, version: task.version + 1, status: 'running', plan };
    this.tasks.set(taskId, updatedPlan);

    const a1: Assignment = {
      id: uid('asgn'),
      version: 1,
      projectId: task.projectId,
      taskId,
      ...plan.nodes[0],
      status: 'running',
    };
    const a2: Assignment = {
      id: uid('asgn'),
      version: 1,
      projectId: task.projectId,
      taskId,
      ...plan.nodes[1],
      status: 'waiting',
    };
    this.assignments.set(taskId, [a1, a2]);

    const w1: Worker = {
      id: uid('wrk'),
      version: 1,
      projectId: task.projectId,
      taskId,
      role: 'Coder',
      jobId: uid('job'),
      model: 'gpt-5.4-codex',
      provider: 'openai',
      assignmentId: a1.id,
      status: 'running',
      attempt: 1,
    };
    a1.workerId = w1.id;
    this.workers.set(taskId, [w1]);

    const s1: SessionRecord = {
      id: uid('sess'),
      version: 1,
      projectId: task.projectId,
      taskId,
      workerId: w1.id,
      assignmentId: a1.id,
      role: 'Coder',
      status: 'running',
    };
    this.sessions.set(taskId, [s1]);
    this.histories.set(s1.id, [
      { cursor: ++this.seq, sessionId: s1.id, type: 'turn/start', sequence: 1 },
      { cursor: ++this.seq, sessionId: s1.id, type: 'tool/call', sequence: 2, name: 'write_file', callId: 'c1' },
    ]);
    this.emit('tasks.updated', task.projectId, taskId, { id: taskId, status: 'running' });

    await wait(700);
    if (!checkAlive()) return;

    // Emit pending approval gate for write_file
    const codeContent = `// Generated for: ${task.input.slice(0, 80)}\nexport function executeTask(input: string) {\n  return {\n    ok: true,\n    summary: input.trim(),\n    timestamp: new Date().toISOString(),\n  };\n}\n`;
    const appr: Approval = {
      id: uid('appr'),
      version: 1,
      projectId: task.projectId,
      taskId,
      workerId: w1.id,
      assignmentId: a1.id,
      status: 'pending',
      tool: 'write_file',
      action: { path: 'src/solution.ts', text: codeContent },
      digest: uid('sha256').replace(/-/g, ''),
      expires: Date.now() + 120000,
    };
    this.approvals.get(taskId)!.push(appr);
    this.emit('approvals.created', task.projectId, taskId, { id: appr.id });

    const decision = await new Promise<'approve' | 'deny'>((resolve) => {
      this.pendingResolvers.set(appr.id, resolve);
    });
    if (!checkAlive()) return;

    if (decision === 'deny') {
      const cur = this.tasks.get(taskId)!;
      w1.status = 'failed';
      a1.status = 'failed';
      this.tasks.set(taskId, { ...cur, version: cur.version + 1, status: 'failed', code: 'APPROVAL_DENIED' });
      this.emit('tasks.updated', task.projectId, taskId, { id: taskId, status: 'failed' });
      return;
    }

    await wait(600);
    if (!checkAlive()) return;

    // Record evidence + finish Coder + run Tester + Review
    this.evidence.get(taskId)!.push({
      id: uid('ev'),
      version: 2,
      projectId: task.projectId,
      taskId,
      status: 'finished',
      tool: 'write_file',
      workerId: w1.id,
      assignmentId: a1.id,
      approvalId: appr.id,
      digest: appr.digest,
      exitCode: 0,
      stdout: 'Wrote src/solution.ts (194 bytes)\n',
      stderr: '',
      changes: [{ path: 'src/solution.ts', before: null, after: encodeUtf8Base64(codeContent) }],
    });
    w1.status = 'done';
    a1.status = 'done';
    a2.status = 'running';

    const w2: Worker = {
      id: uid('wrk'),
      version: 1,
      projectId: task.projectId,
      taskId,
      role: 'Tester',
      jobId: uid('job'),
      model: 'deepseek-chat',
      provider: 'deepseek',
      assignmentId: a2.id,
      status: 'running',
      attempt: 1,
    };
    a2.workerId = w2.id;
    this.workers.get(taskId)!.push(w2);
    this.emit('workers.created', task.projectId, taskId, { id: w2.id });

    await wait(800);
    if (!checkAlive()) return;

    this.evidence.get(taskId)!.push({
      id: uid('ev'),
      version: 2,
      projectId: task.projectId,
      taskId,
      status: 'finished',
      tool: 'shell',
      workerId: w2.id,
      assignmentId: a2.id,
      digest: uid('dig'),
      exitCode: 0,
      stdout: '✔ executeTask returns verified structure (1.3ms)\nℹ tests 1 · pass 1 · fail 0\n',
      stderr: '',
    });
    w2.status = 'done';
    a2.status = 'done';

    const reviewingTask = this.tasks.get(taskId)!;
    this.tasks.set(taskId, { ...reviewingTask, version: reviewingTask.version + 1, status: 'reviewing' });
    this.emit('tasks.updated', task.projectId, taskId, { id: taskId, status: 'reviewing' });

    await wait(650);
    if (!checkAlive()) return;

    this.artifacts.get(taskId)!.push({
      id: uid('art'),
      version: 1,
      projectId: task.projectId,
      taskId,
      key: 'implement',
      workerId: w1.id,
      assignmentId: a1.id,
      published: true,
      text: `已完成「${task.input}」的规划、沙箱实现与独立验收。\n\n- 新增 [src/solution.ts](file://src/solution.ts) 并完成核心逻辑封装\n- 在无网络隔离 Worker 容器内完成单元测试验证（退出码 \`0\`）\n- Reviewer 独立验收通过，已发布不可变产物记录`,
      files: { 'src/solution.ts': encodeUtf8Base64(codeContent) },
    });

    this.usage.push({
      id: uid('usg'),
      version: 1,
      projectId: task.projectId,
      taskId,
      sessionId: s1.id,
      provider: 'openai',
      model: 'gpt-5.4-codex',
      inputTokens: 3120,
      outputTokens: 980,
      estimatedUSD: 0.0176,
    });

    const finalTask = this.tasks.get(taskId)!;
    this.tasks.set(taskId, {
      ...finalTask,
      version: finalTask.version + 1,
      status: 'completed',
      verdict: { accepted: true, reason: '交付产物与测试执行证据已全部核验通过。' },
    });
    this.emit('tasks.updated', task.projectId, taskId, { id: taskId, status: 'completed' });
  }

  async controlTask(
    id: string,
    action: 'pause' | 'resume' | 'cancel' | 'retry',
    version: number,
  ): Promise<Task> {
    const t = this.tasks.get(id);
    if (!t) throw new ApiError(404, 'NOT_FOUND');
    if (t.version !== version) throw new ApiError(409, 'STALE_VERSION');
    let nextStatus = t.status;
    if (action === 'pause') nextStatus = 'paused';
    else if (action === 'resume') nextStatus = t.previousStatus ?? 'running';
    else if (action === 'cancel') nextStatus = 'cancelled';
    else if (action === 'retry') nextStatus = 'running';

    const updated: Task = {
      ...t,
      version: t.version + 1,
      status: nextStatus,
      previousStatus: action === 'pause' || action === 'cancel' ? t.status : t.previousStatus,
    };
    this.tasks.set(id, updated);
    this.emit('tasks.updated', updated.projectId, id, { id, status: nextStatus });
    return { ...updated };
  }

  async listApprovals(params?: { taskId?: string; projectId?: string }): Promise<Approval[]> {
    const all: Approval[] = [];
    for (const list of this.approvals.values()) all.push(...list);
    return all.filter(
      (a) =>
        (!params?.taskId || a.taskId === params.taskId) &&
        (!params?.projectId || a.projectId === params.projectId),
    );
  }

  async decideApproval(id: string, version: number, decision: 'approve' | 'deny'): Promise<Approval> {
    for (const [taskId, list] of this.approvals.entries()) {
      const idx = list.findIndex((a) => a.id === id);
      if (idx >= 0) {
        const cur = list[idx];
        if (cur.version !== version || cur.status !== 'pending') {
          throw new ApiError(409, 'APPROVAL_INACTIVE');
        }
        const next: Approval = {
          ...cur,
          version: cur.version + 1,
          status: decision === 'approve' ? 'consumed' : 'deny',
        };
        list[idx] = next;
        this.emit('approvals.updated', next.projectId, taskId, { id: next.id, status: next.status });

        const resolver = this.pendingResolvers.get(id);
        if (resolver) {
          this.pendingResolvers.delete(id);
          resolver(decision);
        } else if (taskId === 'task-live-approval') {
          void this.finishSeededApprovalTask(taskId, decision);
        }
        return next;
      }
    }
    throw new ApiError(404, 'NOT_FOUND');
  }

  private async finishSeededApprovalTask(taskId: string, decision: 'approve' | 'deny') {
    const task = this.tasks.get(taskId);
    if (!task) return;
    if (decision === 'deny') {
      this.tasks.set(taskId, { ...task, version: task.version + 1, status: 'failed', code: 'APPROVAL_DENIED' });
      this.emit('tasks.updated', task.projectId, taskId, { id: taskId, status: 'failed' });
      return;
    }
    await new Promise((r) => setTimeout(r, 700));
    this.evidence.get(taskId)!.push({
      id: uid('ev'),
      version: 2,
      projectId: task.projectId,
      taskId,
      status: 'finished',
      tool: 'shell',
      workerId: 'wrk-sec-coder',
      assignmentId: 'asgn-sec-1',
      approvalId: 'appr-live-pending',
      digest: '84c91a7ef012bc98',
      exitCode: 0,
      stdout: '✔ expired approval returns 409 APPROVAL_INACTIVE (3.1ms)\n✔ replay decision with stale version rejected (1.4ms)\n✔ path traversal blocked by strict schema (0.8ms)\nℹ tests 12 · pass 12 · fail 0\n',
      stderr: '',
    });
    const assigns = this.assignments.get(taskId) ?? [];
    for (const a of assigns) a.status = 'done';
    const wrks = this.workers.get(taskId) ?? [];
    for (const w of wrks) w.status = 'done';
    this.artifacts.get(taskId)!.push({
      id: uid('art'),
      version: 1,
      projectId: task.projectId,
      taskId,
      key: 'patch_gate',
      assignmentId: 'asgn-sec-1',
      published: true,
      text: '已批准并完成沙箱安全测试，`security.test.js` 12 项用例全部通过，审批过期吊销与 409 幂等校验已生效。',
      files: {},
    });
    this.tasks.set(taskId, {
      ...task,
      version: task.version + 1,
      status: 'completed',
      verdict: { accepted: true, reason: '安全测试 12/12 通过，所有授权消费均绑定事务与 fencing token。' },
    });
    this.emit('tasks.updated', task.projectId, taskId, { id: taskId, status: 'completed' });
  }

  async listModels(): Promise<ModelSpec[]> {
    return [...this.models];
  }

  async listProviders(): Promise<{ routerReady: boolean; items: ProviderAccount[] }> {
    return { routerReady: true, items: [] };
  }

  private demoGit: GitStatus = {
    available: true,
    branch: 'main',
    dirty: false,
    uncommittedCount: 0,
    branches: ['main'],
    ahead: 0,
    behind: 0,
  };

  async getGitStatus(): Promise<GitStatus> {
    return {
      ...this.demoGit,
      branches: this.demoGit.branches ? [...this.demoGit.branches] : undefined,
    };
  }

  async checkoutGitBranch(branch: string, create = false): Promise<GitStatus> {
    const clean = branch.trim();
    if (!clean || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$/.test(clean) || clean.includes('..')) {
      throw new Error(`无效的分支名：${branch}`);
    }
    const list = new Set(this.demoGit.branches ?? ['main']);
    if (!create && !list.has(clean)) {
      throw new Error(`分支不存在：${clean}`);
    }
    list.add(clean);
    this.demoGit = {
      ...this.demoGit,
      available: true,
      branch: clean,
      branches: [...list],
    };
    return this.getGitStatus();
  }

  async initGitRepo(initialBranch = 'main'): Promise<GitStatus> {
    const branch = initialBranch.trim() || 'main';
    this.demoGit = {
      available: true,
      branch,
      dirty: false,
      uncommittedCount: 0,
      branches: [branch],
      ahead: 0,
      behind: 0,
    };
    return this.getGitStatus();
  }

  async providersHealth(): Promise<ProvidersHealth> {
    return { routerReady: true, items: [], providers: [...this.providers] };
  }

  async providerPresets(): Promise<ProviderPresetCatalog> {
    return { items: {} };
  }

  async listMemory(params?: { projectId?: string; taskId?: string }): Promise<MemoryItem[]> {
    return this.memory.filter(
      (m) =>
        (!params?.projectId || m.projectId === params.projectId) &&
        (!params?.taskId || m.taskId === params.taskId),
    );
  }

  async listUsage(params?: { projectId?: string; taskId?: string }): Promise<UsageItem[]> {
    return this.usage.filter(
      (u) =>
        (!params?.projectId || u.projectId === params.projectId) &&
        (!params?.taskId || u.taskId === params.taskId),
    );
  }

  async getTaskVersion(id: string, version: number): Promise<Task> {
    const t = await this.getTask(id);
    return { ...t, version };
  }

  async listEvents(params?: { taskId?: string; projectId?: string; after?: number }): Promise<EventEnvelope[]> {
    return this.events.filter(
      (e) =>
        e.seq > (params?.after ?? 0) &&
        (!params?.taskId || e.taskId === params.taskId) &&
        (!params?.projectId || e.projectId === params.projectId),
    );
  }

  async loadTaskBundle(taskId: string): Promise<TaskBundle> {
    const task = await this.getTask(taskId);
    const sessions = [...(this.sessions.get(taskId) ?? [])];
    const histories: Record<string, SessionHistoryItem[]> = {};
    for (const s of sessions) {
      histories[s.id] = [...(this.histories.get(s.id) ?? [])];
    }
    return {
      task,
      assignments: [...(this.assignments.get(taskId) ?? [])],
      workers: [...(this.workers.get(taskId) ?? [])],
      sessions,
      histories,
      approvals: [...(this.approvals.get(taskId) ?? [])],
      evidence: [...(this.evidence.get(taskId) ?? [])],
      artifacts: [...(this.artifacts.get(taskId) ?? [])],
      usage: this.usage.filter((u) => u.taskId === taskId),
      events: this.events.filter((e) => e.taskId === taskId),
    };
  }

  subscribeEvents(
    params: { taskId?: string; projectId?: string; after?: number },
    onEvent: (ev: EventEnvelope) => void,
    onStatus?: (state: 'connected' | 'reconnecting' | 'error') => void,
  ): () => void {
    onStatus?.('connected');
    const handler = (ev: EventEnvelope) => {
      if (params.taskId && ev.taskId !== params.taskId) return;
      if (params.projectId && ev.projectId !== params.projectId) return;
      onEvent(ev);
    };
    this.listeners.add(handler);
    return () => {
      this.listeners.delete(handler);
    };
  }
}
