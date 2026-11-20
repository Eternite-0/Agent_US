import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { checkHardBlockedCommand } from './tools.js';
import { ExecutePermitRegistry } from './permits.js';
import { guardToolOutput } from './context.js';
import { wrapUntrusted } from './envelope.js';
import { sha256Hex } from './integrity.js';
import {
  applyCodexPatch,
  applyFuzzyEdit,
  canonicalizeCommandPrefix,
  matchesApprovedPrefix,
  runQuickDiagnostics,
} from './patch-and-diagnostics.js';

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

const PROTECTED_BASENAMES = new Set(['.pool-key', '.dev-token']);

export const WORKSPACE_TOOL_META = Object.freeze({
  read_file: { readOnly: true, risk: 'low' },
  glob: { readOnly: true, risk: 'low' },
  grep: { readOnly: true, risk: 'low' },
  read_blob: { readOnly: true, risk: 'low' },
  web_fetch: { readOnly: true, risk: 'low' },
  search_history: { readOnly: true, risk: 'low' },
  read_process_output: { readOnly: true, risk: 'low' },
  update_plan: { readOnly: true, risk: 'low' },
  spawn_subagent: { readOnly: true, risk: 'low' },
  edit_file: { readOnly: false, risk: 'medium' },
  write_file: { readOnly: false, risk: 'medium' },
  apply_patch: { readOnly: false, risk: 'medium' },
  bash: { readOnly: false, risk: 'high' },
  start_process: { readOnly: false, risk: 'high' },
  kill_process: { readOnly: false, risk: 'medium' },
});

const SAFE_READONLY_CMD_RE =
  /^\s*(?:git\s+(?:status|diff|log|branch|show|rev-parse)\b|ls\b|dir\b|pwd\b|echo\b|cat\b|type\b|head\b|tail\b|wc\b|node\s+-v\b|npm\s+--version\b|which\b|where\b)/i;

// ---- Persistent Background Process Manager (Codex unified_exec style) ----

export class BackgroundProcessManager {
  constructor() {
    this.processes = new Map(); // procId -> { child, command, cwd, output, running, exitCode, startedAt }
    this.seq = 0;
  }

  start(command, cwd) {
    const procId = `proc_${++this.seq}_${Date.now().toString(36)}`;
    const isWin = process.platform === 'win32';
    const bin = isWin ? 'powershell.exe' : 'sh';
    const args = isWin
      ? ['-NoProfile', '-NonInteractive', '-Command', command]
      : ['-lc', command];
    const child = spawn(bin, args, {
      cwd,
      windowsHide: true,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const entry = {
      id: procId,
      command,
      cwd,
      child,
      output: '',
      running: true,
      exitCode: null,
      startedAt: Date.now(),
    };
    const append = (chunk) => {
      entry.output += chunk.toString('utf8');
      if (entry.output.length > 128 * 1024) {
        entry.output = entry.output.slice(-96 * 1024);
      }
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.on('close', (code) => {
      entry.running = false;
      entry.exitCode = code ?? 0;
    });
    child.on('error', (err) => {
      entry.running = false;
      entry.exitCode = -1;
      entry.output += `\n[process error: ${String(err?.message ?? err)}]`;
    });
    this.processes.set(procId, entry);
    return entry;
  }

  read(procId, { tailChars = 8000 } = {}) {
    const entry = this.processes.get(procId);
    if (!entry) return null;
    const cap = Math.min(32000, Math.max(200, Number(tailChars || 8000)));
    return {
      id: entry.id,
      command: entry.command,
      running: entry.running,
      exitCode: entry.exitCode,
      uptimeMs: Date.now() - entry.startedAt,
      output: entry.output.slice(-cap),
    };
  }

  kill(procId) {
    const entry = this.processes.get(procId);
    if (!entry) return false;
    try {
      entry.child.kill('SIGTERM');
    } catch {
      // ignore
    }
    entry.running = false;
    return true;
  }

  closeAll() {
    for (const entry of this.processes.values()) {
      if (entry.running) {
        try {
          entry.child.kill('SIGTERM');
        } catch {
          // ignore
        }
      }
    }
    this.processes.clear();
  }
}

export function resolveSafePath(workspaceRoot, rawPath) {
  const root = resolve(workspaceRoot);
  const input = String(rawPath ?? '').trim();
  if (!input) throw new Error('路径不能为空');
  const full = isAbsolute(input) ? resolve(input) : resolve(root, input);
  const rel = relative(root, full);
  if (
    rel.startsWith('..') ||
    isAbsolute(rel) ||
    rel.split(sep).includes('..')
  ) {
    throw new Error(`路径超出当前工作区边界: ${input}`);
  }
  const parts = rel ? rel.split(/[\\/]/) : [];
  if (parts.includes('.git')) {
    throw new Error('不允许直接修改或读取 .git 内部对象目录');
  }
  const base = parts.at(-1) ?? '';
  if (PROTECTED_BASENAMES.has(base)) {
    throw new Error(`受保护的密钥文件不允许访问: ${base}`);
  }
  return { full, rel: rel.replace(/\\/g, '/') || '.' };
}

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
    if (SKIP_DIRS.has(ent.name)) continue;
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

function isPrivateOrLocalHost(hostname) {
  const h = String(hostname || '').toLowerCase();
  if (
    h === 'localhost' ||
    h === '::1' ||
    h === '[::1]' ||
    h.endsWith('.local') ||
    h.endsWith('.internal')
  ) {
    return true;
  }
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 127 || a === 10 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function runLocalCommand(
  command,
  cwd,
  { timeoutMs = 30000, signal, onOutput = null } = {},
) {
  return new Promise((resolveRun, rejectRun) => {
    const isWin = process.platform === 'win32';
    const bin = isWin ? 'powershell.exe' : 'sh';
    const args = isWin
      ? ['-NoProfile', '-NonInteractive', '-Command', command]
      : ['-lc', command];

    const child = spawn(bin, args, {
      cwd,
      windowsHide: true,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    const MAX_CAPTURE = 256 * 1024;
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore
      }
      resolveRun({
        exitCode: 124,
        stdout,
        stderr: `${stderr}\n[timeout after ${timeoutMs}ms]`.trim(),
        timedOut: true,
      });
    }, Math.min(Math.max(1000, timeoutMs), 120000));

    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore
      }
      rejectRun(new Error('命令执行已取消'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (chunk) => {
      const str = chunk.toString('utf8');
      if (stdout.length < MAX_CAPTURE) stdout += str;
      onOutput?.({ stream: 'stdout', chunk: str });
    });
    child.stderr.on('data', (chunk) => {
      const str = chunk.toString('utf8');
      if (stderr.length < MAX_CAPTURE) stderr += str;
      onOutput?.({ stream: 'stderr', chunk: str });
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      rejectRun(err);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolveRun({
        exitCode: code ?? 0,
        stdout,
        stderr,
        timedOut: false,
      });
    });
  });
}

export function needsApproval(
  toolName,
  args,
  permissionMode = 'auto-safe',
  { approvedPrefixes = [] } = {},
) {
  const meta = WORKSPACE_TOOL_META[toolName];
  if (meta?.readOnly) return false;
  if (permissionMode === 'full-access') return false;
  if (
    (toolName === 'bash' || toolName === 'start_process') &&
    matchesApprovedPrefix(args?.command, approvedPrefixes)
  ) {
    return false;
  }
  if (permissionMode === 'auto-safe') {
    if (
      toolName === 'edit_file' ||
      toolName === 'write_file' ||
      toolName === 'apply_patch'
    ) {
      return false;
    }
    if (
      toolName === 'bash' &&
      SAFE_READONLY_CMD_RE.test(String(args?.command ?? '')) &&
      !/[;&|><`]|\$\(/.test(String(args?.command ?? ''))
    ) {
      return false;
    }
    return true;
  }
  return true;
}

export function createWorkspaceTools({
  workspaceRoot,
  store,
  sessionId = null,
  permissionMode = 'auto-safe',
  nonce = '',
  getApprovedPrefixes = () => [],
  readFileState = new Map(),
  processManager = null,
  mcpTools = [],
  requestApproval = async () => true,
  onBeforeMutate = () => {},
  onFileChanged = () => {},
  onToolOutput = () => {},
  onPlanUpdated = () => {},
  runSubagent = null,
  signal = undefined,
}) {
  const permits = new ExecutePermitRegistry();
  const permitOwner = Object.freeze({ workspaceRoot });
  const bgProcs = processManager ?? new BackgroundProcessManager();
  let seq = 0;

  const wrapResult = (name, rawText) => {
    const guarded = guardToolOutput(name, rawText, store);
    if (!nonce) return guarded;
    return wrapUntrusted(nonce, `tool-${name}-${++seq}`, guarded);
  };

  // Claude Code stale-file protection: refuse overwriting files modified externally after read_file
  const checkStaleFile = (rel, full) => {
    const tracked = readFileState.get(rel);
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
    readFileState.set(rel, {
      sha256: sha256Hex(content),
      at: Date.now(),
    });
  };

  const gateAndPermit = async (toolName, args, callId) => {
    let approvalId = null;
    if (
      needsApproval(toolName, args, permissionMode, {
        approvedPrefixes: getApprovedPrefixes(),
      })
    ) {
      const prefix =
        toolName === 'bash' || toolName === 'start_process'
          ? canonicalizeCommandPrefix(args?.command)
          : null;
      const allowed = await requestApproval({
        tool: toolName,
        arguments: { ...args, ...(prefix ? { commandPrefix: prefix } : {}) },
        callId,
      });
      if (!allowed) {
        throw new Error(`用户拒绝了 ${toolName} 操作`);
      }
      approvalId = `approved-${callId || ++seq}`;
    }
    const effectId = `${toolName}-${callId || 'local'}-${++seq}`;
    const evidenceId = `ev-${effectId}`;
    const binding = {
      owner: permitOwner,
      effectId,
      evidenceId,
      approvalId,
      callId: callId ?? null,
      attempt: 1,
    };
    const permit = permits.issue(binding);
    permits.consume(permit, binding);
  };

  const tools = [
    {
      name: 'read_file',
      description:
        '读取工作区内的文本文件内容（带行号）。支持通过 startLine / endLine 分段阅读大文件。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对工作区路径（或工作区内绝对路径）' },
          startLine: { type: 'integer', description: '起始行号（从 1 开始，可选）' },
          endLine: { type: 'integer', description: '结束行号（含，可选，单次最多 400 行）' },
        },
        required: ['path'],
      },
      async execute(args) {
        const { full, rel } = resolveSafePath(workspaceRoot, args.path);
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
        const end = Math.min(
          total,
          args.endLine ? Number(args.endLine) : start + 399,
        );
        const slice = lines
          .slice(start - 1, end)
          .map((line, i) => `${start + i}: ${line}`)
          .join('\n');
        const header = `File: ${rel} (lines ${start}-${end} of ${total})`;
        return wrapResult('read_file', `${header}\n${slice}`);
      },
    },
    {
      name: 'edit_file',
      description:
        '对工作区已有文件做精准局部替换（内置 Codex 4 级容错匹配与自动语法诊断）。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '目标文件路径' },
          target: { type: 'string', description: '要被替换的原始文本块' },
          replacement: { type: 'string', description: '替换后的新文本块' },
          replaceAll: {
            type: 'boolean',
            description: '是否替换全部匹配项（默认 false，要求唯一匹配）',
          },
        },
        required: ['path', 'target', 'replacement'],
      },
      async execute(args, ctx) {
        const { full, rel } = resolveSafePath(workspaceRoot, args.path);
        if (!existsSync(full)) throw new Error(`文件不存在: ${rel}`);
        const target = String(args.target ?? '');
        const replacement = String(args.replacement ?? '');
        if (!target) throw new Error('target 不能为空');

        checkStaleFile(rel, full);
        await gateAndPermit('edit_file', { path: rel, target, replacement }, ctx?.callId);

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
        onFileChanged({
          path: rel,
          before: Buffer.from(before, 'utf8').toString('base64'),
          after: Buffer.from(applied.after, 'utf8').toString('base64'),
        });
        const diag = runQuickDiagnostics(full, rel);
        return `已成功编辑 ${rel}（匹配级别: ${applied.tier}，替换 ${applied.replacedCount} 处）。${diag.summary}`;
      },
    },
    {
      name: 'write_file',
      description: '新建文件或完整覆写工作区内指定文件，自动创建缺失父目录并执行快速语法诊断。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '目标文件路径' },
          content: { type: 'string', description: '文件完整内容' },
        },
        required: ['path', 'content'],
      },
      async execute(args, ctx) {
        const { full, rel } = resolveSafePath(workspaceRoot, args.path);
        const content = String(args.content ?? '');
        if (existsSync(full)) checkStaleFile(rel, full);
        await gateAndPermit(
          'write_file',
          { path: rel, bytes: Buffer.byteLength(content, 'utf8') },
          ctx?.callId,
        );
        const existed = existsSync(full);
        const before = existed ? readFileSync(full, 'utf8') : null;
        onBeforeMutate(rel, full);
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, content, 'utf8');
        trackFileHash(rel, content);
        onFileChanged({
          path: rel,
          before: before !== null ? Buffer.from(before, 'utf8').toString('base64') : null,
          after: Buffer.from(content, 'utf8').toString('base64'),
        });
        const diag = runQuickDiagnostics(full, rel);
        return `${existed ? '已覆写' : '已创建'} ${rel} (${Buffer.byteLength(content, 'utf8')} bytes)。${diag.summary}`;
      },
    },
    {
      name: 'apply_patch',
      description:
        'Codex 风格多文件原子补丁工具：在一次调用中原子完成多处编辑、新建、移动与删除。格式：`*** Begin Patch` / `*** Update File: <path>` / `*** Add File: <path>` / `*** Delete File: <path>` / `@@ <context>` / `+`/`-`/` ` 行 / `*** End Patch`。',
      parameters: {
        type: 'object',
        properties: {
          patch: { type: 'string', description: '完整 Codex 补丁文本' },
        },
        required: ['patch'],
      },
      async execute(args, ctx) {
        const patch = String(args.patch ?? '');
        if (!patch.trim()) throw new Error('patch 不能为空');
        await gateAndPermit(
          'apply_patch',
          { preview: patch.slice(0, 400) },
          ctx?.callId,
        );
        const touched = applyCodexPatch(patch, {
          workspaceRoot,
          resolveSafePath,
          checkStale: checkStaleFile,
          onBeforeMutate,
          onFileChanged,
        });
        const diagNotes = [];
        for (const t of touched) {
          if (t.action !== 'deleted' && existsSync(t.full)) {
            trackFileHash(t.path, readFileSync(t.full, 'utf8'));
            const d = runQuickDiagnostics(t.full, t.path);
            if (!d.ok) diagNotes.push(d.summary);
          }
        }
        const summary = touched.map((t) => `${t.action}: ${t.path}`).join('\n');
        return `原子补丁已成功应用 (${touched.length} 个文件):\n${summary}${diagNotes.join('')}`;
      },
    },
    {
      name: 'glob',
      description: '按通配符模式快速查找工作区内的文件（自动忽略 node_modules 与 .git）。',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: '如 **/*.ts 或 src/**/*.js' },
          path: { type: 'string', description: '限定子目录（可选）' },
          maxResults: { type: 'integer', description: '最大返回条数（默认 100）' },
        },
        required: ['pattern'],
      },
      async execute(args) {
        const base = args.path
          ? resolveSafePath(workspaceRoot, args.path).full
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
        if (!matched.length) return `未找到匹配「${args.pattern}」的文件。`;
        return wrapResult(
          'glob',
          `找到 ${matched.length} 个匹配文件:\n${matched.join('\n')}`,
        );
      },
    },
    {
      name: 'grep',
      description: '在工作区代码文件中搜索文本或正则表达式，返回精确的文件名、行号和内容。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词或正则表达式' },
          path: { type: 'string', description: '限定搜索的子目录或单文件（可选）' },
          isRegex: { type: 'boolean', description: '是否按正则解析（默认 false）' },
          glob: { type: 'string', description: '限定文件名通配符如 *.ts（可选）' },
          maxResults: { type: 'integer', description: '最多返回匹配行（默认 80）' },
        },
        required: ['query'],
      },
      async execute(args) {
        const query = String(args.query ?? '');
        if (!query) throw new Error('query 不能为空');
        const base = args.path
          ? resolveSafePath(workspaceRoot, args.path).full
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
            const fst = statSync(f.full);
            if (fst.size > 1024 * 1024) continue;
            const buf = readFileSync(f.full);
            if (isProbablyBinary(buf)) continue;
            const lines = buf.toString('utf8').replace(/\r\n/g, '\n').split('\n');
            for (let i = 0; i < lines.length; i++) {
              if (rx.test(lines[i])) {
                hits.push(`${f.rel}:${i + 1}: ${lines[i].trim().slice(0, 220)}`);
                if (hits.length >= limit) break;
              }
            }
          } catch {
            // skip unreadable
          }
        }
        if (!hits.length) return `未搜索到匹配「${query}」的内容。`;
        return wrapResult('grep', hits.join('\n'));
      },
    },
    {
      name: 'bash',
      description:
        '在当前项目工作区执行本地终端命令（实时流式日志输出），适合运行测试、构建、git 等一次性命令。',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要执行的 Shell 命令' },
          cwd: { type: 'string', description: '可选的相对子目录' },
          timeoutMs: { type: 'integer', description: '超时毫秒数（默认 30000，上限 120000）' },
        },
        required: ['command'],
      },
      async execute(args, ctx) {
        const command = String(args.command ?? '').trim();
        if (!command) throw new Error('command 不能为空');
        const blocked = checkHardBlockedCommand(['sh', '-c', command]);
        if (blocked) {
          throw new Error(`安全红线拦截：拒绝执行高危命令 (${blocked})`);
        }
        const cwd = args.cwd
          ? resolveSafePath(workspaceRoot, args.cwd).full
          : resolve(workspaceRoot);
        await gateAndPermit('bash', { command, cwd }, ctx?.callId);
        const res = await runLocalCommand(command, cwd, {
          timeoutMs: Number(args.timeoutMs ?? 30000),
          signal,
          onOutput: (chunk) =>
            onToolOutput({
              callId: ctx?.callId,
              name: 'bash',
              ...chunk,
            }),
        });
        const combined = [
          `exitCode: ${res.exitCode}`,
          res.stdout?.trim() ? `stdout:\n${res.stdout.trim()}` : '',
          res.stderr?.trim() ? `stderr:\n${res.stderr.trim()}` : '',
        ]
          .filter(Boolean)
          .join('\n');
        return wrapResult('bash', combined);
      },
    },
    {
      name: 'start_process',
      description:
        '在后台启动长驻进程（如 dev server / 文件监听器 / 长耗时构建），返回 processId 供后续 read_process_output 与 kill_process 管理。',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要启动的后台命令' },
          cwd: { type: 'string', description: '可选的相对子目录' },
        },
        required: ['command'],
      },
      async execute(args, ctx) {
        const command = String(args.command ?? '').trim();
        if (!command) throw new Error('command 不能为空');
        const blocked = checkHardBlockedCommand(['sh', '-c', command]);
        if (blocked) throw new Error(`安全红线拦截：拒绝启动高危命令 (${blocked})`);
        const cwd = args.cwd
          ? resolveSafePath(workspaceRoot, args.cwd).full
          : resolve(workspaceRoot);
        await gateAndPermit('start_process', { command, cwd }, ctx?.callId);
        const proc = bgProcs.start(command, cwd);
        return `已启动后台进程 ${proc.id} (${command})。可用 read_process_output 查看实时日志，或用 kill_process 停止。`;
      },
    },
    {
      name: 'read_process_output',
      description: '读取后台进程最近的运行状态与日志输出。',
      parameters: {
        type: 'object',
        properties: {
          processId: { type: 'string', description: 'start_process 返回的进程 ID' },
          tailChars: { type: 'integer', description: '尾部最大字符数（默认 8000）' },
        },
        required: ['processId'],
      },
      async execute(args) {
        const info = bgProcs.read(String(args.processId ?? ''), {
          tailChars: args.tailChars,
        });
        if (!info) return `未找到后台进程: ${args.processId}`;
        return wrapResult(
          'read_process_output',
          `processId: ${info.id} | running: ${info.running} | exitCode: ${info.exitCode}\n${info.output || '(暂无输出)'}`,
        );
      },
    },
    {
      name: 'kill_process',
      description: '终止通过 start_process 启动的后台进程。',
      parameters: {
        type: 'object',
        properties: {
          processId: { type: 'string', description: '要停止的后台进程 ID' },
        },
        required: ['processId'],
      },
      async execute(args, ctx) {
        await gateAndPermit('kill_process', { processId: args.processId }, ctx?.callId);
        const ok = bgProcs.kill(String(args.processId ?? ''));
        return ok ? `已停止后台进程 ${args.processId}` : `未找到后台进程 ${args.processId}`;
      },
    },
    {
      name: 'update_plan',
      description:
        '维护当前多步骤任务的轻量级进度清单（Codex update_plan / Claude Code TodoWrite）。实时同步到用户界面，帮助长任务不跑偏。',
      parameters: {
        type: 'object',
        properties: {
          explanation: { type: 'string', description: '简短说明本次进度变更（可选）' },
          steps: {
            type: 'array',
            description: '完整任务步骤清单（每步标注 pending / in_progress / completed）',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                title: { type: 'string' },
                status: {
                  type: 'string',
                  enum: ['pending', 'in_progress', 'completed'],
                },
              },
              required: ['title', 'status'],
            },
          },
        },
        required: ['steps'],
      },
      async execute(args) {
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
    },
    {
      name: 'search_history',
      description:
        '使用 SQLite FTS5 全文检索当前工作区过往对话记录与已解决的问题（跨会话长期记忆）。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '检索关键词' },
          limit: { type: 'integer', description: '返回条数上限（默认 8）' },
        },
        required: ['query'],
      },
      async execute(args) {
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
    },
    {
      name: 'read_blob',
      description: '读取被折叠溢写到 artifact://<sha256> 的超长工具输出片段。',
      parameters: {
        type: 'object',
        properties: {
          uri: { type: 'string', description: 'artifact://<sha256> URI' },
          start: { type: 'integer', description: '起始字符偏移（默认 0）' },
          maxChars: { type: 'integer', description: '最大读取字符数（默认 4000）' },
        },
        required: ['uri'],
      },
      async execute(args) {
        const blob = store.getBlob(String(args.uri ?? ''));
        const start = Math.max(0, Number(args.start ?? 0));
        const maxChars = Math.min(16000, Math.max(200, Number(args.maxChars ?? 4000)));
        const slice = blob.content.slice(start, start + maxChars);
        return wrapResult(
          'read_blob',
          `[blob ${blob.sha256.slice(0, 12)} chars ${start}-${start + slice.length} / ${blob.content.length}]\n${slice}`,
        );
      },
    },
    {
      name: 'web_fetch',
      description: '只读抓取公开 HTTPS 网页内容用于查阅文档（自动防御 SSRF 与提示注入）。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '公开 https:// URL' },
        },
        required: ['url'],
      },
      async execute(args) {
        let parsed;
        try {
          parsed = new URL(String(args.url ?? ''));
        } catch {
          throw new Error('无效 URL');
        }
        if (parsed.protocol !== 'https:') {
          throw new Error('web_fetch 仅允许公开 https:// 链接');
        }
        if (isPrivateOrLocalHost(parsed.hostname)) {
          throw new Error('安全拦截：不允许抓取本机或内网地址');
        }
        const res = await fetch(parsed.href, {
          headers: { 'User-Agent': 'Agent-US/1.0' },
          redirect: 'follow',
          signal: AbortSignal.timeout(12000),
        });
        if (!res.ok) return `抓取失败: HTTP ${res.status}`;
        const raw = await res.text();
        const text = /<html|<body|<div/i.test(raw) ? stripHtml(raw) : raw;
        return wrapResult('web_fetch', text.slice(0, 16000));
      },
    },
  ];

  if (typeof runSubagent === 'function') {
    tools.push({
      name: 'spawn_subagent',
      description:
        '按需派生独立的调研/分析子代理（独立上下文窗口蒸馏结果，避免主上下文膨胀）。支持单任务 objective 或并行 tasks 数组，支持可选 isolatedWorktree 隔离验证。',
      parameters: {
        type: 'object',
        properties: {
          objective: { type: 'string', description: '单个子任务目标' },
          tasks: {
            type: 'array',
            description: '并行扇出多个只读调研子任务（最多 4 个）',
            items: { type: 'string' },
          },
          role: { type: 'string', description: '角色名，如 Researcher / CodeReviewer' },
          maxSteps: { type: 'integer', description: '步数预算上限（默认 6，最多 10）' },
          isolatedWorktree: {
            type: 'boolean',
            description: '是否在临时独立 Git Worktree 中运行（默认 false）',
          },
        },
      },
      async execute(args) {
        const objectives = Array.isArray(args.tasks) && args.tasks.length
          ? args.tasks.slice(0, 4).map(String)
          : [String(args.objective ?? '')].filter(Boolean);
        if (!objectives.length) throw new Error('必须提供 objective 或 tasks');
        const role = String(args.role ?? 'Researcher');
        const maxSteps = Math.min(10, Math.max(1, Number(args.maxSteps ?? 6)));
        const isolatedWorktree = Boolean(args.isolatedWorktree);
        const results = await Promise.all(
          objectives.map((obj, idx) =>
            runSubagent({
              objective: obj,
              role: objectives.length > 1 ? `${role}-${idx + 1}` : role,
              maxSteps,
              isolatedWorktree,
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
    });
  }

  // Mount discovered MCP Server tools cleanly with approval gating & <untrusted> wrapping
  for (const mt of mcpTools) {
    tools.push({
      name: mt.fullName,
      description: mt.description,
      parameters: mt.parameters,
      async execute(args, ctx) {
        await gateAndPermit(mt.fullName, args, ctx?.callId);
        const out = await mt.call(args);
        return wrapResult(mt.fullName, String(out ?? ''));
      },
    });
  }

  return tools;
}
