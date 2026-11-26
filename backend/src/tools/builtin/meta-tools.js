import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { z } from 'zod';
import { canonicalJson, sha256Hex } from '../../integrity.js';
import { estimateTokens } from '../../context.js';
import { extractBoundedSymbolSpans, extractSymbolsFromText } from '../../context/aci-engine.js';
import { Fault } from '../../store.js';
import { PolicyError } from '../../kernel/errors.js';
import { normalizeProtectedSegment, resolveConfinedPath } from '../sandbox.js';
import { EFFECT_CLASSES, RISK_LEVELS, defineTool } from '../registry.js';
import { safeFetchExternal } from '../ssrf-guard.js';

const MAX_WEB_FETCH_BYTES = 512 * 1024;
const MAX_DIGEST_FILE_BYTES = 10 * 1024 * 1024;

function isBlockedWorkspaceRel(relPath) {
  const normRel = String(relPath ?? '').replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
  if (
    normRel === 'upstream' ||
    normRel.startsWith('upstream/') ||
    normRel === 'var' ||
    normRel.startsWith('var/') ||
    normRel === 'backend/var' ||
    normRel.startsWith('backend/var/')
  ) {
    return true;
  }
  const segments = String(relPath ?? '').split(/[\\/]/).filter(Boolean);
  return segments.some((seg) => {
    const norm = normalizeProtectedSegment(seg);
    return (
      norm === '.git' ||
      norm === 'upstream' ||
      norm === 'var' ||
      /^\.env(?:$|[._-])/i.test(norm) ||
      /\.(?:pem|key|pfx|p12|crt|der|sqlite(?:3)?|sqlite-wal|sqlite-shm)$/i.test(norm)
    );
  });
}

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
  workspaceRoot = null,
  store,
  sessionId,
  mcpTools = [],
  wrapResult,
  guardFallback,
  onPlanUpdated,
  resolveContextRef = null,
  runSubagent = null,
  orchestrateSwarm = null,
  sendAgentMessage = null,
  includeTools = null,
  signal = undefined,
}) {
  const allowedSet =
    includeTools instanceof Set
      ? includeTools
      : Array.isArray(includeTools)
        ? new Set(includeTools)
        : null;
  const want = (name) => allowedSet === null || allowedSet.has(name);
  const tools = [];
  if (want('update_plan')) {
    tools.push(
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
        hypotheses: z
          .array(
            z.union([
              z.string(),
              z.object({
                id: z.string().optional(),
                statement: z.string().optional(),
                title: z.string().optional(),
                status: z
                  .enum(['active', 'confirmed', 'falsified', 'rejected', 'pending'])
                  .optional(),
                evidence: z.string().optional(),
              }),
            ]),
          )
          .max(20)
          .optional()
          .describe('可选：当前根因假设与证伪/确认状态列表'),
        verificationCriteria: z
          .array(
            z.union([
              z.string(),
              z.object({
                description: z.string(),
                status: z.enum(['pending', 'passed', 'failed']).optional(),
              }),
            ]),
          )
          .max(20)
          .optional()
          .describe('可选：验收与验证通过标准列表'),
        blockers: z
          .array(
            z.union([
              z.string(),
              z.object({
                id: z.string().optional(),
                description: z.string().optional(),
                title: z.string().optional(),
                severity: z.enum(['low', 'medium', 'high', 'critical']).optional(),
                resolved: z.boolean().optional(),
              }),
            ]),
          )
          .max(20)
          .optional()
          .describe('可选：当前阻塞项或待解风险列表'),
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
        if (Array.isArray(args.hypotheses)) {
          plan.hypotheses = args.hypotheses
            .slice(0, 20)
            .map((h, idx) => {
              if (typeof h === 'string') return h.trim().slice(0, 400);
              return {
                id: String(h.id || `h-${idx + 1}`),
                statement: String(h.statement ?? h.title ?? '').trim().slice(0, 400),
                status: h.status ?? 'active',
                ...(h.evidence ? { evidence: String(h.evidence).trim().slice(0, 400) } : {}),
              };
            })
            .filter((h) => (typeof h === 'string' ? Boolean(h) : Boolean(h.statement)));
        }
        if (Array.isArray(args.verificationCriteria)) {
          plan.verificationCriteria = args.verificationCriteria
            .slice(0, 20)
            .map((c) => {
              if (typeof c === 'string') return c.trim().slice(0, 400);
              return {
                description: String(c.description ?? '').trim().slice(0, 400),
                status: c.status ?? 'pending',
              };
            })
            .filter((c) => (typeof c === 'string' ? Boolean(c) : Boolean(c.description)));
        }
        if (Array.isArray(args.blockers)) {
          plan.blockers = args.blockers
            .slice(0, 20)
            .map((b, idx) => {
              if (typeof b === 'string') return b.trim().slice(0, 400);
              return {
                id: String(b.id || `blk-${idx + 1}`),
                description: String(b.description ?? b.title ?? '').trim().slice(0, 400),
                severity: b.severity ?? 'medium',
                resolved: Boolean(b.resolved),
              };
            })
            .filter((b) => (typeof b === 'string' ? Boolean(b) : Boolean(b.description)));
        }
        onPlanUpdated(plan);
        const done = steps.filter((s) => s.status === 'completed').length;
        return `任务清单已更新（${done}/${steps.length} 已完成）。`;
      },
    }),
    );
  }

  if (want('search_history')) {
    tools.push(
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
    );
  }

  if (want('read_blob')) {
    tools.push(
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
    );
  }

  if (want('compute_file_digest')) {
    tools.push(
    defineTool({
      name: 'compute_file_digest',
      readOnly: true,
      description:
        '只读计算工作区内指定文件的确定性 SHA-256 十六进制摘要与字节长度（`.json` 文件同步计算 RFC-8785 规范化 JSON 摘要及排序组合摘要），无需执行 shell 命令。',
      effectClass: EFFECT_CLASSES.READ_ONLY,
      riskLevel: RISK_LEVELS.LOW,
      replayable: true,
      outward: false,
      zodSchema: z.object({
        paths: z
          .array(z.string().min(1))
          .min(1)
          .max(16)
          .describe('工作区内 1–16 个目标文件路径列表'),
      }),
      async execute(args, ctx) {
        await guardFallback('compute_file_digest', args, ctx);
        if (!workspaceRoot) {
          throw new Error('compute_file_digest requires an active workspaceRoot');
        }
        const realRoot = realpathSync(resolve(workspaceRoot));
        const entries = [];
        for (const rawPath of args.paths) {
          const confined = resolveConfinedPath(workspaceRoot, rawPath);
          if (isBlockedWorkspaceRel(confined.rel)) {
            throw new Error(`受保护目录或密钥文件不允许访问: ${rawPath}`);
          }
          if (!existsSync(confined.full)) {
            throw new Error(`文件不存在: ${confined.rel}`);
          }
          const realTarget = realpathSync(confined.full);
          const realRel = relative(realRoot, realTarget).replace(/\\/g, '/');
          if (realRel.startsWith('..') || isBlockedWorkspaceRel(realRel)) {
            throw new Error(`受保护目录或密钥文件不允许访问: ${rawPath}`);
          }
          const st = statSync(realTarget);
          if (!st.isFile()) {
            throw new Error(`目标不是常规文件: ${confined.rel}`);
          }
          if (st.size > MAX_DIGEST_FILE_BYTES) {
            throw new Error(`文件超出摘要读取上限 (${MAX_DIGEST_FILE_BYTES} bytes): ${confined.rel}`);
          }
          const buf = readFileSync(realTarget);
          const sha256 = createHash('sha256').update(buf).digest('hex');
          const normPath = confined.rel.replace(/\\/g, '/');
          const entry = {
            path: normPath,
            sha256,
            bytes: buf.length,
          };
          if (normPath.toLowerCase().endsWith('.json')) {
            try {
              const parsed = JSON.parse(buf.toString('utf8'));
              entry.canonicalJsonSha256 = sha256Hex(canonicalJson(parsed));
            } catch (err) {
              entry.jsonParseError = String(err?.message ?? err);
            }
          }
          entries.push(entry);
        }
        const sortedForBundle = [...entries]
          .sort((a, b) => a.path.localeCompare(b.path))
          .map(({ path: p, sha256 }) => ({ path: p, sha256 }));
        const sortedArtifactsSha256 = sha256Hex(JSON.stringify(sortedForBundle));
        return wrapResult(
          'compute_file_digest',
          JSON.stringify(
            {
              files: entries,
              sortedArtifactsSha256,
            },
            null,
            2,
          ),
        );
      },
    }),
    );
  }

  if (want('expand_context')) {
    tools.push(
    defineTool({
      name: 'expand_context',
      readOnly: true,
      description: '无损恢复 artifact/refId 原文（支持符号/行号/大纲）。',
      effectClass: EFFECT_CLASSES.READ_ONLY,
      riskLevel: RISK_LEVELS.LOW,
      replayable: true,
      outward: false,
      zodSchema: z.object({
        ref: z.string().min(1).optional().describe('artifact:// URI或refId'),
        uri: z.string().min(1).optional(),
        refId: z.string().min(1).optional(),
        level: z.enum(['verbatim', 'hunk', 'outline']).optional(),
        symbol: z.string().optional(),
        symbols: z.array(z.string().min(1)).max(20).optional(),
        startLine: z.number().int().min(1).optional(),
        endLine: z.number().int().min(1).optional(),
        offset: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(32768).optional(),
      }),
      async execute(args, ctx) {
        await guardFallback('expand_context', args, ctx);
        const rawRef = String(args.ref ?? args.uri ?? args.refId ?? '').trim();
        if (!rawRef) {
          throw new Error('expand_context requires ref, uri, or refId');
        }
        const level =
          args.level === 'hunk' || args.level === 'outline' ? args.level : 'verbatim';
        const requestedSymbols = [
          ...(args.symbol ? [args.symbol] : []),
          ...(Array.isArray(args.symbols) ? args.symbols : []),
        ]
          .map((s) => String(s ?? '').trim())
          .filter(Boolean);

        let blob = null;
        let resolvedMeta = null;
        if (typeof resolveContextRef === 'function') {
          const resolved = await resolveContextRef(rawRef, {
            level,
            symbol: args.symbol,
            symbols: requestedSymbols,
            startLine: args.startLine,
            endLine: args.endLine,
            offset: args.offset,
            limit: args.limit,
            recordLedger: false,
          });
          if (resolved && typeof resolved.content === 'string') {
            if (resolved.verified === false) {
              throw new Fault('ARTIFACT_HASH_MISMATCH', 500, {
                message: `Artifact hash verification failed for ${rawRef}`,
              });
            }
            resolvedMeta = resolved;
            blob = {
              sha256: resolved.sha256 ?? sha256Hex(resolved.content),
              content: resolved.content,
              path: resolved.path ?? '',
            };
          } else if (resolved && typeof resolved.uri === 'string') {
            blob = store.getBlob(resolved.uri);
          }
        }
        if (!blob) {
          const clean = rawRef.replace(/^ref:/i, '').replace(/^aci:\/\//i, '');
          let lookupUri = clean;
          if (!/^artifact:\/\//i.test(clean) && !/^[0-9a-f]{64}$/i.test(clean) && typeof store?.getSetting === 'function') {
            const mapped =
              store.getSetting(`aci.ref:${clean}`) ??
              store.getSetting(`aci_ref:${clean}`);
            const mappedUri = typeof mapped === 'string' ? mapped : mapped?.uri;
            if (mappedUri) {
              lookupUri = mappedUri;
              blob = store.getBlob(mappedUri);
            }
          }
          if (!blob) {
            blob = store.getBlob(clean);
          }
          const actual = sha256Hex(String(blob.content ?? ''));
          const uriHashMatch = String(lookupUri).match(/^(?:artifact:\/\/)?([0-9a-f]{64})$/i);
          const expectedFromUri = uriHashMatch?.[1]?.toLowerCase() ?? null;
          if (
            (blob.sha256 && actual !== String(blob.sha256).toLowerCase()) ||
            (expectedFromUri && actual !== expectedFromUri)
          ) {
            throw new Fault('ARTIFACT_HASH_MISMATCH', 500, {
              message: `Artifact SHA-256 mismatch for ${rawRef}`,
              expectedSha256: expectedFromUri ?? blob.sha256 ?? null,
              actualSha256: actual,
            });
          }
          blob = { ...blob, sha256: actual };
        }

        const fullText = String(blob.content ?? '');
        const actualSha256 = sha256Hex(fullText);
        if (blob.sha256 && actualSha256 !== String(blob.sha256).toLowerCase()) {
          throw new Fault('ARTIFACT_HASH_MISMATCH', 500, {
            message: `Artifact SHA-256 mismatch for ${rawRef}`,
            expectedSha256: blob.sha256,
            actualSha256,
          });
        }

        const lines = fullText.split('\n');
        const maxChars = Math.min(32768, Math.max(1, Number(args.limit ?? 16384)));
        let slice = fullText;
        let rangeDesc = '';
        let mode = 'full';

        if (level === 'outline') {
          mode = 'outline';
          const pathForParse = blob.path || 'file';
          const extracted = extractSymbolsFromText(pathForParse, fullText);
          const imports = lines
            .map((line, i) => ({ line, num: i + 1 }))
            .filter((x) => /^\s*(?:#include\b|import\b|export\s+.*from\b|from\s+\S+\s+import\b|use\s+|using\s+|package\s+)/.test(x.line))
            .slice(0, 16)
            .map((x) => `L${x.num}: ${x.line.trim()}`);
          const symbolLines = (extracted.definitions ?? [])
            .slice(0, 40)
            .map((d) => `L${d.line}: [${d.kind}] ${d.name}`);
          const sections = [`[ACI-OUTLINE ${pathForParse} | ${lines.length} lines]`];
          if (imports.length) sections.push(`Imports:\n${imports.join('\n')}`);
          if (symbolLines.length) sections.push(`Symbols:\n${symbolLines.join('\n')}`);
          if (!imports.length && !symbolLines.length) {
            sections.push(lines.slice(0, 20).map((l, idx) => `L${idx + 1}: ${l}`).join('\n'));
          }
          slice = sections.join('\n\n').slice(0, maxChars);
          rangeDesc = `outline (${lines.length} lines)`;
        } else if (level === 'hunk') {
          mode = 'hunk';
          if (args.startLine !== undefined || args.endLine !== undefined) {
            const sLine = Math.max(1, Number(args.startLine ?? 1));
            const eLine = Math.min(lines.length, Math.max(sLine, Number(args.endLine ?? lines.length)));
            slice = lines
              .slice(sLine - 1, eLine)
              .map((l, idx) => `L${sLine + idx}: ${l}`)
              .join('\n')
              .slice(0, maxChars);
            rangeDesc = `hunk lines ${sLine}-${eLine}/${lines.length}`;
          } else if (requestedSymbols.length > 0) {
            const spanRes = extractBoundedSymbolSpans(
              blob.path || 'file',
              fullText,
              requestedSymbols,
              { fallbackRadius: 12, maxChars },
            );
            if (spanRes.text) {
              slice = spanRes.text;
              rangeDesc = `hunk ${spanRes.rangeDesc}`;
            } else {
              const previewEnd = Math.min(lines.length, 30);
              slice = lines
                .slice(0, previewEnd)
                .map((l, idx) => `L${idx + 1}: ${l}`)
                .join('\n')
                .slice(0, maxChars);
              rangeDesc = `hunk (symbol not found; L1-${previewEnd}/${lines.length})`;
            }
          } else {
            const previewEnd = Math.min(lines.length, 30);
            slice = lines
              .slice(0, previewEnd)
              .map((l, idx) => `L${idx + 1}: ${l}`)
              .join('\n')
              .slice(0, maxChars);
            rangeDesc = `hunk (L1-${previewEnd}/${lines.length})`;
          }
        } else if (requestedSymbols.length > 0) {
          mode = 'symbol';
          const spanRes = extractBoundedSymbolSpans(
            blob.path || 'file',
            fullText,
            requestedSymbols,
            { fallbackRadius: 12, maxChars },
          );
          if (spanRes.text) {
            slice = spanRes.text;
            rangeDesc = spanRes.rangeDesc;
          } else {
            const fallbackEnd = Math.min(lines.length, 25);
            slice = lines
              .slice(0, fallbackEnd)
              .map((l, idx) => `L${idx + 1}: ${l}`)
              .join('\n')
              .slice(0, maxChars);
            rangeDesc = `symbols(not-found) L1-${fallbackEnd}/${lines.length}`;
          }
        } else if (args.startLine !== undefined || args.endLine !== undefined) {
          mode = 'lines';
          const sLine = Math.max(1, Number(args.startLine ?? 1));
          const eLine = Math.min(lines.length, Math.max(sLine, Number(args.endLine ?? lines.length)));
          const selected = lines.slice(sLine - 1, eLine).join('\n');
          const lineMaxChars = Math.min(32768, Math.max(1, Number(args.limit ?? 32768)));
          slice = selected.slice(0, lineMaxChars);
          rangeDesc = `lines ${sLine}-${eLine}/${lines.length}`;
        } else {
          const offset = Math.max(0, Number(args.offset ?? 0));
          slice = fullText.slice(offset, offset + maxChars);
          mode = offset > 0 || slice.length < fullText.length ? 'lines' : 'full';
          rangeDesc = `chars ${offset}-${offset + slice.length}/${fullText.length}`;
        }

        const fullTokens = estimateTokens(fullText);
        const tokensRestored = estimateTokens(slice);
        const sliceSha256 = sha256Hex(slice);
        const isPartial = mode !== 'full' || slice.length < fullText.length;
        const effectiveMode = isPartial && mode === 'full' ? 'lines' : mode;
        const tokensSaved = isPartial ? Math.max(0, fullTokens - tokensRestored) : 0;

        resolvedMeta?.recordRecovery?.({
          level,
          mode: effectiveMode,
          isPartial,
          fullTokens,
          tokensRestored,
          tokensSaved,
          sliceSha256,
          path: blob.path || '',
        });

        return wrapResult(
          'expand_context',
          `[expand_context sha256:${actualSha256.slice(0, 12)} verified=true ${rangeDesc}] [sliceSha256:${sliceSha256.slice(0, 12)} verified=true mode=${effectiveMode}]\n${slice}`,
        );
      },
    }),
    );
  }

  if (want('web_fetch')) {
    tools.push(
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
    );
  }

  if (want('spawn_subagent') && typeof runSubagent === 'function') {
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

  if (want('swarm_orchestrate') && typeof orchestrateSwarm === 'function') {
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

  if (want('send_agent_message') && typeof sendAgentMessage === 'function') {
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
