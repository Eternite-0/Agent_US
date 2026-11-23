import { z } from 'zod';
import { PolicyError } from '../../kernel/errors.js';
import { EFFECT_CLASSES, RISK_LEVELS, defineTool } from '../registry.js';
import { safeFetchExternal } from '../ssrf-guard.js';

const MAX_WEB_FETCH_BYTES = 512 * 1024;

async function readResponseTextCapped(res, maxBytes = MAX_WEB_FETCH_BYTES) {
  if (res?.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    const chunks = [];
    let received = 0;
    let truncated = false;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const buf = Buffer.from(value);
        const remaining = maxBytes - received;
        if (buf.length > remaining) {
          if (remaining > 0) chunks.push(buf.subarray(0, remaining));
          received = maxBytes;
          truncated = true;
          await reader.cancel().catch(() => {});
          break;
        }
        chunks.push(buf);
        received += buf.length;
      }
    } finally {
      reader.releaseLock();
    }
    return { text: Buffer.concat(chunks).toString('utf8'), truncated };
  }
  const raw = String((await res.text()) ?? '');
  const buf = Buffer.from(raw, 'utf8');
  if (buf.length > maxBytes) {
    return { text: buf.subarray(0, maxBytes).toString('utf8'), truncated: true };
  }
  return { text: raw, truncated: false };
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function createMetaTools({
  store,
  sessionId,
  mcpTools = [],
  wrapResult,
  guardFallback,
  onPlanUpdated,
  runSubagent = null,
  orchestrateSwarm = null,
  sendAgentMessage = null,
  signal = undefined,
}) {
  const tools = [
    defineTool({
      name: 'update_plan',
      isConcurrencySafe: () => false,
      description:
        '维护当前多步骤任务的轻量级进度清单（Codex update_plan / Claude Code TodoWrite）。实时同步到用户界面，帮助长任务不跑偏。',
      effectClass: EFFECT_CLASSES.READ_ONLY,
      riskLevel: RISK_LEVELS.LOW,
      replayable: true,
      outward: false,
      zodSchema: z.object({
        explanation: z.string().optional().describe('简短说明本次进度变更（可选）'),
        steps: z
          .array(
            z.object({
              id: z.string().optional(),
              title: z.string(),
              status: z.enum(['pending', 'in_progress', 'completed']),
            }),
          )
          .describe('完整任务步骤清单（每步标注 pending / in_progress / completed）'),
      }),
      async execute(args, ctx) {
        await guardFallback('update_plan', args, ctx);
        const rawSteps = Array.isArray(args.steps) ? args.steps : [];
        const steps = rawSteps.slice(0, 20).map((s, idx) => ({
          id: String(s.id || `step-${idx + 1}`),
          title: String(s.title || '').slice(0, 200),
          status: ['pending', 'in_progress', 'completed'].includes(s.status)
            ? s.status
            : 'pending',
        }));
        const plan = {
          explanation: args.explanation ? String(args.explanation).slice(0, 400) : '',
          steps,
          updatedAt: Date.now(),
        };
        onPlanUpdated(plan);
        const done = steps.filter((s) => s.status === 'completed').length;
        return `任务清单已更新（${done}/${steps.length} 已完成）。`;
      },
    }),

    defineTool({
      name: 'search_history',
      description:
        '使用 SQLite FTS5 全文检索当前工作区过往对话记录与已解决的问题（跨会话长期记忆）。',
      effectClass: EFFECT_CLASSES.READ_ONLY,
      riskLevel: RISK_LEVELS.LOW,
      replayable: true,
      outward: false,
      zodSchema: z.object({
        query: z.string().min(1).describe('检索关键词'),
        limit: z.number().int().min(1).max(50).optional().describe('返回条数上限（默认 8）'),
      }),
      async execute(args, ctx) {
        await guardFallback('search_history', args, ctx);
        const hits = store.searchDirectHistory(String(args.query ?? ''), {
          excludeSessionId: sessionId,
          limit: Number(args.limit ?? 8),
        });
        if (!hits.length) return `未在历史会话中检索到与「${args.query}」相关的内容。`;
        const lines = hits.map(
          (h) =>
            `[${h.sessionTitle || h.sessionId.slice(0, 8)} · ${h.role}] ${String(h.snippet || '').replace(/\s+/g, ' ')}`,
        );
        return wrapResult('search_history', lines.join('\n'));
      },
    }),

    defineTool({
      name: 'read_blob',
      description: '读取被折叠溢写到 artifact://<sha256> 的超长工具输出片段。',
      effectClass: EFFECT_CLASSES.READ_ONLY,
      riskLevel: RISK_LEVELS.LOW,
      replayable: true,
      outward: false,
      zodSchema: z.object({
        uri: z.string().min(1).describe('artifact://<sha256> URI'),
        start: z.number().int().min(0).optional().describe('起始字符偏移（默认 0）'),
        offset: z.number().int().min(0).optional().describe('起始字符偏移别名（兼容 offset/limit）'),
        maxChars: z.number().int().min(1).max(16384).optional().describe('最大读取字符数（默认 4000）'),
        limit: z.number().int().min(1).max(16384).optional().describe('最大读取字符数别名（兼容 offset/limit）'),
      }),
      async execute(args, ctx) {
        await guardFallback('read_blob', args, ctx);
        const blob = store.getBlob(String(args.uri ?? ''));
        const start = Math.max(0, Number(args.start ?? args.offset ?? 0));
        const maxChars = Math.min(
          16384,
          Math.max(1, Number(args.maxChars ?? args.limit ?? 4000)),
        );
        const slice = blob.content.slice(start, start + maxChars);
        return wrapResult(
          'read_blob',
          `[blob ${blob.sha256.slice(0, 12)} chars ${start}-${start + slice.length} / ${blob.content.length}]\n${slice}`,
        );
      },
    }),

    defineTool({
      name: 'web_fetch',
      description: '只读抓取公开 HTTPS 网页内容用于查阅文档（自动防御 SSRF、DNS 重绑定、跳转与提示注入）。',
      effectClass: EFFECT_CLASSES.EXTERNAL_NETWORK,
      riskLevel: RISK_LEVELS.LOW,
      readOnly: true,
      replayable: true,
      outward: false,
      zodSchema: z.object({
        url: z.string().min(1).describe('公开 https:// URL'),
      }),
      async execute(args, ctx) {
        if (ctx?.tainted && !ctx?.approvalId) {
          throw new PolicyError('WEB_FETCH_TAINTED_BLOCKED', {
            message: '安全拦截：当前上下文受污染 (tainted)，禁止在未经人工审批的情况下执行外联 web_fetch',
          });
        }
        await guardFallback('web_fetch', args, ctx);
        const res = await safeFetchExternal(args.url, {
          signal: ctx?.signal ?? signal,
        });
        if (!res.ok) {
          await res.body?.cancel?.().catch(() => {});
          return `抓取失败: HTTP ${res.status}`;
        }
        const { text: raw, truncated } = await readResponseTextCapped(res, MAX_WEB_FETCH_BYTES);
        const text = /<html|<body|<div/i.test(raw) ? stripHtml(raw) : raw;
        const suffix = truncated ? '\n[... truncated at 512KB stream limit ...]' : '';
        return wrapResult('web_fetch', `${text.slice(0, 16000)}${suffix}`);
      },
    }),
  ];

  if (typeof runSubagent === 'function') {
    tools.push(
      defineTool({
        name: 'spawn_subagent',
        isConcurrencySafe: () => false,
        description:
          '按需派生或 Fork 独立的子代理（独立上下文或缓存复用上下文）。支持单任务 objective、并行 tasks 数组、mode (spawn|fork)、resumeSessionId 与 isolatedWorktree 隔离验证。',
        effectClass: EFFECT_CLASSES.READ_ONLY,
        riskLevel: RISK_LEVELS.LOW,
        replayable: true,
        outward: false,
        zodSchema: z.object({
          objective: z.string().optional().describe('单个子任务目标'),
          tasks: z.array(z.string()).optional().describe('并行扇出多个子任务（最多 4 个）'),
          role: z.string().optional().describe('角色/能力画像名'),
          mode: z.enum(['spawn', 'fork']).optional().describe('spawn 全新上下文 或 fork 继承父会话前缀'),
          resumeSessionId: z.string().optional().describe('恢复已有子会话 ID'),
          maxSteps: z.number().int().min(1).max(16).optional().describe('步数预算上限'),
          isolatedWorktree: z.boolean().optional().describe('是否在临时独立 Git Worktree 中运行'),
        }),
        async execute(args, ctx) {
          await guardFallback('spawn_subagent', args, ctx);
          if (args.resumeSessionId) {
            const out = await runSubagent({
              resumeSessionId: args.resumeSessionId,
              objective: String(args.objective ?? '继续执行未完成任务'),
              role: String(args.role ?? 'Researcher'),
              maxSteps: Math.min(12, Math.max(1, Number(args.maxSteps ?? 6))),
              isolatedWorktree: Boolean(args.isolatedWorktree),
              mode: args.mode ?? 'spawn',
            });
            return wrapResult('spawn_subagent', String(out || '子代理未返回内容'));
          }
          const objectives =
            Array.isArray(args.tasks) && args.tasks.length
              ? args.tasks.slice(0, 4).map(String)
              : [String(args.objective ?? '')].filter(Boolean);
          if (!objectives.length) throw new Error('必须提供 objective 或 tasks');
          const role = String(args.role ?? 'Researcher');
          const maxSteps = Math.min(12, Math.max(1, Number(args.maxSteps ?? 6)));
          const isolatedWorktree = Boolean(args.isolatedWorktree);
          const mode = args.mode ?? 'spawn';
          const results = await Promise.all(
            objectives.map((obj, idx) =>
              runSubagent({
                objective: obj,
                role: objectives.length > 1 ? `${role}-${idx + 1}` : role,
                maxSteps,
                isolatedWorktree,
                mode,
              }),
            ),
          );
          const text =
            results.length === 1
              ? String(results[0] || '子代理未返回内容')
              : results
                  .map((r, i) => `### 子任务 ${i + 1}: ${objectives[i]}\n${r || '(无输出)'}`)
                  .join('\n\n');
          return wrapResult('spawn_subagent', text);
        },
      }),
    );
  }

  if (typeof orchestrateSwarm === 'function') {
    tools.push(
      defineTool({
        name: 'swarm_orchestrate',
        description: '将复杂多阶段目标自动规划为自适应 DAG 并调度动态 Agent Swarm 并发执行与聚合交付。',
        effectClass: EFFECT_CLASSES.REVERSIBLE_WRITE,
        riskLevel: RISK_LEVELS.MEDIUM,
        replayable: false,
        outward: false,
        zodSchema: z.object({
          goal: z.string().min(1).describe('复杂任务总目标'),
          maxConcurrency: z.number().int().min(1).max(6).optional(),
        }),
        async execute(args, ctx) {
          await guardFallback('swarm_orchestrate', args, ctx);
          const summary = await orchestrateSwarm({
            goal: args.goal,
            maxConcurrency: args.maxConcurrency ?? 3,
          });
          return wrapResult('swarm_orchestrate', typeof summary === 'string' ? summary : JSON.stringify(summary));
        },
      }),
    );
  }

  if (typeof sendAgentMessage === 'function') {
    tools.push(
      defineTool({
        name: 'send_agent_message',
        description: '向同一 Swarm 运行中的其他子代理发送结构化协同消息。',
        effectClass: EFFECT_CLASSES.READ_ONLY,
        riskLevel: RISK_LEVELS.LOW,
        replayable: false,
        outward: false,
        zodSchema: z.object({
          toAgentId: z.string().min(1),
          kind: z.string().optional(),
          message: z.string().min(1),
        }),
        async execute(args, ctx) {
          await guardFallback('send_agent_message', args, ctx);
          const res = await sendAgentMessage({ ...args, operationId: ctx?.callId ?? null });
          return wrapResult('send_agent_message', JSON.stringify(res));
        },
      }),
    );
  }

  for (const mt of mcpTools) {
    tools.push(
      defineTool({
        name: mt.fullName,
        description: mt.description,
        parameters: mt.parameters,
        effectClass: EFFECT_CLASSES.EXTERNAL_NETWORK,
        riskLevel: RISK_LEVELS.HIGH,
        replayable: false,
        outward: true,
        async execute(args, ctx) {
          await guardFallback(mt.fullName, args, ctx);
          const out = await mt.call(args, { signal: ctx?.signal ?? signal });
          if (out?.isError === true) ctx?.reportOutcome?.({ errorCode: 'MCP_TOOL_ERROR' });
          if (out?.outcomeUnknown === true) {
            ctx?.reportOutcome?.({ errorCode: 'MCP_OUTCOME_UNKNOWN', outcomeUnknown: true });
          }
          return wrapResult(mt.fullName, String(out?.text ?? out ?? ''));
        },
      }),
    );
  }

  return tools;
}
