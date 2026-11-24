import { z } from 'zod';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { sha256Hex } from '../../integrity.js';
import {
  applyCodexPatch,
  applyFuzzyEdit,
  computeUnifiedDiff,
  runDiagnostics,
  runQuickDiagnostics,
} from '../../patch-and-diagnostics.js';
import { EFFECT_CLASSES, RISK_LEVELS, defineTool } from '../registry.js';
import { isProtectedPathSegment, resolveConfinedPath } from '../sandbox.js';
import { isExecutableConfigPath } from '../hook-trust.js';

const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin';
const stateKeyFor = (rel) => (CASE_INSENSITIVE_FS ? String(rel).toLowerCase() : String(rel));

const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'target',
  '.next',
  '.nuxt',
  '.cache',
  '__pycache__',
  '.venv',
  'upstream',
]);

function globToRegex(pattern) {
  const norm = String(pattern || '*').replace(/\\/g, '/');
  let re = '^';
  for (let i = 0; i < norm.length; i++) {
    const ch = norm[i];
    if (ch === '*') {
      if (norm[i + 1] === '*') {
        if (norm[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (ch === '?') {
      re += '[^/]';
    } else if ('^$+?.()|[]{}'.includes(ch)) {
      re += '\\' + ch;
    } else {
      re += ch;
    }
  }
  re += '$';
  return new RegExp(re, 'i');
}

function walkFiles(dir, root, out, maxFiles = 5000) {
  if (out.length >= maxFiles) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (out.length >= maxFiles) break;
    if (ent.isSymbolicLink()) continue;
    if (SKIP_DIRS.has(ent.name.toLowerCase()) || isProtectedPathSegment(ent.name)) continue;
    const full = resolve(dir, ent.name);
    if (ent.isDirectory()) {
      walkFiles(full, root, out, maxFiles);
    } else if (ent.isFile()) {
      out.push({
        full,
        rel: relative(root, full).replace(/\\/g, '/'),
      });
    }
  }
}

function isProbablyBinary(buf) {
  const sample = buf.subarray(0, Math.min(buf.length, 4096));
  for (let i = 0; i < sample.length; i++) {
    if (sample[i] === 0) return true;
  }
  return false;
}

export function createFsTools({
  workspaceRoot,
  dataRoot = null,
  readFileState,
  wrapResult,
  guardFallback,
  onBeforeMutate,
  onFileChanged,
  onHookConfigMutated = null,
}) {
  const notifyIfHookConfig = (rel, full, toolName, action = 'write') => {
    if (!isExecutableConfigPath(rel, { workspaceRoot, dataRoot })) return '';
    try {
      onHookConfigMutated?.({ path: full, rel, action, toolName });
    } catch {
      // never fail file write due to revocation notification
    }
    return `\n[Hook Trust] 检测到写入可执行配置文件 (${rel})：未信任草稿不会自动激活或执行，需人工显式审批对应 SHA-256 摘要后方可生效。`;
  };
  const checkStaleFile = (rel, full) => {
    const tracked = readFileState.get(stateKeyFor(rel));
    if (!tracked || !existsSync(full)) return;
    try {
      const curHash = sha256Hex(readFileSync(full, 'utf8'));
      if (curHash !== tracked.sha256) {
        throw new Error(
          `防脏写拦截：${rel} 在你上次 read_file 之后已被外部修改，请先重新 read_file 获取最新内容再编辑。`,
        );
      }
    } catch (err) {
      if (String(err?.message).startsWith('防脏写拦截')) throw err;
    }
  };

  const trackFileHash = (rel, content) => {
    readFileState.set(stateKeyFor(rel), {
      sha256: sha256Hex(content),
      at: Date.now(),
    });
  };

  return [
    defineTool({
      name: 'read_file',
      description:
        '读取工作区内的文本文件内容（带行号）。支持通过 startLine / endLine 分段阅读大文件。',
      effectClass: EFFECT_CLASSES.READ_ONLY,
      riskLevel: RISK_LEVELS.LOW,
      replayable: true,
      outward: false,
      zodSchema: z.object({
        path: z.string().min(1).describe('相对工作区路径（或工作区内绝对路径）'),
        startLine: z.number().int().min(1).optional().describe('起始行号（从 1 开始，可选）'),
        endLine: z.number().int().min(1).optional().describe('结束行号（含，可选，单次最多 400 行）'),
      }),
      async execute(args, ctx) {
        await guardFallback('read_file', args, ctx);
        const { full, rel } = resolveConfinedPath(workspaceRoot, args.path);
        if (!existsSync(full)) return `文件不存在: ${rel}`;
        const st = statSync(full);
        if (st.isDirectory()) {
          const items = readdirSync(full).slice(0, 100);
          return `路径是目录 (${rel})，包含 ${items.length} 项:\n${items.join('\n')}`;
        }
        const buf = readFileSync(full);
        if (isProbablyBinary(buf)) {
          return `二进制文件 (${rel}, ${buf.length} bytes)，跳过文本展示。`;
        }
        const text = buf.toString('utf8');
        trackFileHash(rel, text);
        const lines = text.replace(/\r\n/g, '\n').split('\n');
        const total = lines.length;
        const start = Math.max(1, Number(args.startLine ?? 1));
        const end = Math.min(total, args.endLine ? Number(args.endLine) : start + 399);
        const slice = lines
          .slice(start - 1, end)
          .map((line, i) => `${start + i}: ${line}`)
          .join('\n');
        return wrapResult('read_file', `File: ${rel} (lines ${start}-${end} of ${total})\n${slice}`);
      },
    }),

    defineTool({
      name: 'edit_file',
      description:
        '对已有文件做局部替换。先用 read_file 获取最新内容；若文件已变化或目标不匹配，重新读取再编辑。多文件修改可用 apply_patch；快速语法诊断不代替测试。',
      effectClass: EFFECT_CLASSES.REVERSIBLE_WRITE,
      riskLevel: RISK_LEVELS.MEDIUM,
      replayable: true,
      outward: false,
      zodSchema: z.object({
        path: z.string().min(1).describe('目标文件路径'),
        target: z.string().min(1).describe('要被替换的原始文本块'),
        replacement: z.string().describe('替换后的新文本块'),
        replaceAll: z.boolean().optional().describe('是否替换全部匹配项（默认 false）'),
      }),
      async execute(args, ctx) {
        const { full, rel } = resolveConfinedPath(workspaceRoot, args.path);
        if (!existsSync(full)) throw new Error(`文件不存在: ${rel}`);
        const target = String(args.target ?? '');
        const replacement = String(args.replacement ?? '');
        if (!target) throw new Error('target 不能为空');

        checkStaleFile(rel, full);
        await guardFallback('edit_file', { path: rel, target, replacement }, ctx);

        const before = readFileSync(full, 'utf8');
        const applied = applyFuzzyEdit(before, target, replacement, {
          replaceAll: Boolean(args.replaceAll),
        });
        if (!applied.ok) {
          throw new Error(`编辑 ${rel} 失败：${applied.error}`);
        }

        onBeforeMutate(rel, full);
        writeFileSync(full, applied.after, 'utf8');
        trackFileHash(rel, applied.after);
        const editDiff = computeUnifiedDiff(rel, before, applied.after, { action: 'updated' });
        onFileChanged({
          path: rel,
          before: Buffer.from(before, 'utf8').toString('base64'),
          after: Buffer.from(applied.after, 'utf8').toString('base64'),
          action: 'updated',
          unifiedDiff: editDiff.unifiedDiff,
          additions: editDiff.additions,
          deletions: editDiff.deletions,
          sha256After: sha256Hex(applied.after),
        });
        const hookNotice = notifyIfHookConfig(rel, full, 'edit_file', 'edit');
        const diag = runQuickDiagnostics(full, rel);
        return `已成功编辑 ${rel}（匹配级别: ${applied.tier}，替换 ${applied.replacedCount} 处）。${diag.summary}${hookNotice}`;
      },
    }),

    defineTool({
      name: 'write_file',
      description: '新建文件或完整覆写工作区内指定文件，自动创建缺失父目录并执行快速语法诊断。',
      effectClass: EFFECT_CLASSES.REVERSIBLE_WRITE,
      riskLevel: RISK_LEVELS.MEDIUM,
      replayable: true,
      outward: false,
      zodSchema: z.object({
        path: z.string().min(1).describe('目标文件路径'),
        content: z.string().describe('文件完整内容'),
      }),
      async execute(args, ctx) {
        const { full, rel } = resolveConfinedPath(workspaceRoot, args.path);
        const content = String(args.content ?? '');
        if (existsSync(full)) checkStaleFile(rel, full);
        await guardFallback(
          'write_file',
          { path: rel, bytes: Buffer.byteLength(content, 'utf8') },
          ctx,
        );
        const existed = existsSync(full);
        const before = existed ? readFileSync(full, 'utf8') : null;
        onBeforeMutate(rel, full);
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, content, 'utf8');
        trackFileHash(rel, content);
        const writeAction = existed ? 'updated' : 'added';
        const writeDiff = computeUnifiedDiff(rel, before, content, { action: writeAction });
        onFileChanged({
          path: rel,
          before: before !== null ? Buffer.from(before, 'utf8').toString('base64') : null,
          after: Buffer.from(content, 'utf8').toString('base64'),
          action: writeAction,
          unifiedDiff: writeDiff.unifiedDiff,
          additions: writeDiff.additions,
          deletions: writeDiff.deletions,
          sha256After: sha256Hex(content),
        });
        const hookNotice = notifyIfHookConfig(rel, full, 'write_file', existed ? 'overwrite' : 'create');
        const diag = runQuickDiagnostics(full, rel);
        return `${existed ? '已覆写' : '已创建'} ${rel} (${Buffer.byteLength(content, 'utf8')} bytes)。${diag.summary}${hookNotice}`;
      },
    }),

    defineTool({
      name: 'apply_patch',
      serializeZodSchema: false,
      description:
        '高精度多文件原子补丁工具（修改已有文件优先使用）：同时透明支持 Codex 补丁（`*** Begin Patch`...`*** End Patch`）与标准 unified diff（`--- a/...`/`+++ b/...`/`@@ ... @@`），支持 `expectedHashes` 乐观并发锁与提交前 JS/JSON 语法校验，并返回紧凑 diff 摘要与新 SHA-256。',
      effectClass: EFFECT_CLASSES.REVERSIBLE_WRITE,
      riskLevel: RISK_LEVELS.MEDIUM,
      replayable: true,
      outward: false,
      zodSchema: z.object({
        patch: z.string().min(1).describe('完整补丁文本（Codex 格式或标准 unified diff）'),
        format: z
          .enum(['auto', 'codex', 'unified'])
          .optional()
          .describe('补丁格式（默认 auto 自动识别）'),
        expectedHashes: z
          .record(z.string(), z.string())
          .optional()
          .describe('可选：按相对路径指定的期望 SHA-256 哈希映射，不匹配时原子拒绝并返回 OPTIMISTIC_LOCK_CONFLICT'),
        allowSyntaxError: z
          .boolean()
          .optional()
          .describe('是否允许写入存在语法错误的 JS/JSON 文件（默认 false，提交前校验失败原子拒绝）'),
      }),
      async execute(args, ctx) {
        const patch = String(args.patch ?? '');
        if (!patch.trim()) throw new Error('patch 不能为空');
        await guardFallback('apply_patch', { preview: patch.slice(0, 400) }, ctx);
        const touched = applyCodexPatch(patch, {
          workspaceRoot,
          resolveSafePath: resolveConfinedPath,
          format: args.format ?? 'auto',
          expectedHashes: args.expectedHashes ?? null,
          allowSyntaxError: Boolean(args.allowSyntaxError),
          readFileState,
          checkStale: checkStaleFile,
          onBeforeMutate,
          onFileChanged,
        });
        const diagNotes = [];
        const hookNotices = [];
        const summaryLines = [];
        let totalHunkChars = 0;
        for (const t of touched) {
          const hn = notifyIfHookConfig(t.path, t.full, 'apply_patch', t.action);
          if (hn) hookNotices.push(hn);
          if (t.fromPath) {
            readFileState.delete(stateKeyFor(t.fromPath));
          }
          if (t.action === 'deleted') {
            readFileState.delete(stateKeyFor(t.path));
          } else if (existsSync(t.full)) {
            trackFileHash(t.path, readFileSync(t.full, 'utf8'));
            const d = runQuickDiagnostics(t.full, t.path);
            if (!d.ok) diagNotes.push(d.summary);
          }
          const shaShort = t.sha256After ? `, sha256: ${t.sha256After.slice(0, 16)}` : '';
          summaryLines.push(`- ${t.action}: ${t.path} (+${t.additions ?? 0}/-${t.deletions ?? 0}${shaShort})`);
          if (t.compactHunks && totalHunkChars < 2400) {
            const hunkSlice = t.compactHunks.slice(0, 2400 - totalHunkChars);
            totalHunkChars += hunkSlice.length;
            summaryLines.push(hunkSlice);
          }
        }
        return `原子补丁已成功应用 (${touched.length} 个文件):\n${summaryLines.join('\n')}${diagNotes.join('')}${hookNotices.join('')}`;
      },
    }),

    defineTool({
      name: 'run_diagnostics',
      serializeZodSchema: false,
      description:
        '只读结构化诊断工具（受工作区沙箱约束）：快速执行语法检查（node --check / JSON.parse）、类型检查（tsc --noEmit）或测试（node --test），并将冗长输出去重压缩为结构化 JSON（diagnostics、failingTests、compression）与精简摘要。',
      effectClass: EFFECT_CLASSES.READ_ONLY,
      riskLevel: RISK_LEVELS.LOW,
      replayable: true,
      outward: false,
      zodSchema: z.object({
        kind: z
          .enum(['auto', 'syntax', 'typecheck', 'test', 'lint'])
          .optional()
          .describe('诊断类型：auto（默认）、syntax、typecheck、test、lint'),
        paths: z
          .array(z.string().min(1))
          .max(50)
          .optional()
          .describe('可选：限定诊断的工作区内文件或子目录路径列表'),
        testPattern: z
          .string()
          .max(240)
          .optional()
          .describe('可选：传递给 node --test --test-name-pattern 的测试名过滤模式'),
        maxDiagnostics: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe('最多保留的诊断条目与失败测试条数（默认 25）'),
      }),
      async execute(args = {}, ctx) {
        await guardFallback('run_diagnostics', args, ctx);
        const result = runDiagnostics(workspaceRoot, {
          kind: args.kind ?? 'auto',
          paths: args.paths ?? [],
          testPattern: args.testPattern ?? '',
          maxDiagnostics: args.maxDiagnostics ?? 25,
        });
        const structuredJson = JSON.stringify({
          ok: result.ok,
          kind: result.kind,
          diagnostics: result.diagnostics,
          failingTests: result.failingTests,
          compression: result.compression,
        });
        return wrapResult('run_diagnostics', `${result.summary}\n\n${structuredJson}`);
      },
    }),

    defineTool({
      name: 'glob',
      description: '按文件名/路径通配符找文件（不搜索内容）；找文本或符号引用用 grep。自动忽略 node_modules 和 .git。',
      effectClass: EFFECT_CLASSES.READ_ONLY,
      riskLevel: RISK_LEVELS.LOW,
      replayable: true,
      outward: false,
      zodSchema: z.object({
        pattern: z.string().min(1).describe('如 **/*.ts 或 src/**/*.js'),
        path: z.string().optional().describe('限定子目录（可选）'),
        maxResults: z.number().int().min(1).max(300).optional().describe('最大返回条数（默认 100）'),
      }),
      async execute(args, ctx) {
        await guardFallback('glob', args, ctx);
        const base = args.path
          ? resolveConfinedPath(workspaceRoot, args.path).full
          : resolve(workspaceRoot);
        if (!existsSync(base)) return `目录不存在: ${args.path}`;
        const files = [];
        walkFiles(base, resolve(workspaceRoot), files, 8000);
        const rx = globToRegex(args.pattern);
        const limit = Math.min(300, Math.max(1, Number(args.maxResults ?? 100)));
        const matched = files
          .filter((f) => rx.test(f.rel) || rx.test(f.rel.split('/').at(-1) ?? ''))
          .slice(0, limit)
          .map((f) => f.rel);
        if (!matched.length) return `未找到匹配「${args.pattern}」的文件。确认目录或换更宽的路径模式；相同输入不必重试。`;
        return wrapResult('glob', `找到 ${matched.length} 个匹配文件:\n${matched.join('\n')}`);
      },
    }),

    defineTool({
      name: 'grep',
      description: '按文本或正则找代码位置（文件名、行号、内容）。找到后用 read_file 读取相关行；独立的只读定位可在同一批调用。',
      effectClass: EFFECT_CLASSES.READ_ONLY,
      riskLevel: RISK_LEVELS.LOW,
      replayable: true,
      outward: false,
      zodSchema: z.object({
        query: z.string().min(1).describe('搜索关键词或正则表达式'),
        path: z.string().optional().describe('限定搜索的子目录或单文件（可选）'),
        isRegex: z.boolean().optional().describe('是否按正则解析（默认 false）'),
        glob: z.string().optional().describe('限定文件名通配符如 *.ts（可选）'),
        maxResults: z.number().int().min(1).max(200).optional().describe('最多返回匹配行（默认 80）'),
      }),
      async execute(args, ctx) {
        await guardFallback('grep', args, ctx);
        const query = String(args.query ?? '');
        if (!query) throw new Error('query 不能为空');
        const base = args.path
          ? resolveConfinedPath(workspaceRoot, args.path).full
          : resolve(workspaceRoot);
        if (!existsSync(base)) return `路径不存在: ${args.path}`;
        const rx = args.isRegex
          ? new RegExp(query, 'i')
          : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        const fileFilter = args.glob ? globToRegex(args.glob) : null;
        const limit = Math.min(200, Math.max(1, Number(args.maxResults ?? 80)));

        const files = [];
        const st = statSync(base);
        if (st.isFile()) {
          files.push({
            full: base,
            rel: relative(resolve(workspaceRoot), base).replace(/\\/g, '/'),
          });
        } else {
          walkFiles(base, resolve(workspaceRoot), files, 6000);
        }

        const hits = [];
        for (const f of files) {
          if (hits.length >= limit) break;
          if (
            fileFilter &&
            !fileFilter.test(f.rel) &&
            !fileFilter.test(f.rel.split('/').at(-1) ?? '')
          ) {
            continue;
          }
          try {
            const confined = resolveConfinedPath(workspaceRoot, f.rel);
            const fst = statSync(confined.full);
            if (fst.size > 1024 * 1024) continue;
            const buf = readFileSync(confined.full);
            if (isProbablyBinary(buf)) continue;
            const lines = buf.toString('utf8').replace(/\r\n/g, '\n').split('\n');
            for (let i = 0; i < lines.length; i++) {
              if (rx.test(lines[i])) {
                hits.push(`${confined.rel}:${i + 1}: ${lines[i].trim().slice(0, 220)}`);
                if (hits.length >= limit) break;
              }
            }
          } catch {
            // skip unreadable or protected/escaped paths
          }
        }
        if (!hits.length) return `未搜索到匹配「${query}」的内容。可改关键词或放宽文件过滤；未命中不代表文件不存在。`;
        return wrapResult('grep', hits.join('\n'));
      },
    }),
  ];
}
