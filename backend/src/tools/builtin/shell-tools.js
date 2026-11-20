import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { z } from 'zod';
import { EFFECT_CLASSES, RISK_LEVELS, defineTool } from '../registry.js';
import { analyzeCommand } from '../command-analyzer.js';
import {
  HostSandboxAdapter,
  killProcessTree,
  resolveConfinedPath,
  sanitizeChildEnv,
} from '../sandbox.js';

export class BackgroundProcessManager {
  constructor() {
    this.processes = new Map();
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
      detached: !isWin,
      env: sanitizeChildEnv(process.env),
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
    killProcessTree(entry.child);
    entry.running = false;
    return true;
  }

  closeAll() {
    for (const entry of this.processes.values()) {
      if (entry.running) killProcessTree(entry.child);
      entry.running = false;
    }
    this.processes.clear();
  }
}

export function createShellTools({
  workspaceRoot,
  bgProcs,
  sandbox = new HostSandboxAdapter(),
  signal,
  wrapResult,
  guardFallback,
  onToolOutput,
}) {
  return [
    defineTool({
      name: 'bash',
      description:
        '在当前项目工作区执行本地终端命令（实时流式日志输出），适合运行测试、构建、git 等一次性命令。',
      effectClass: EFFECT_CLASSES.IRREVERSIBLE_SIDE_EFFECT,
      riskLevel: RISK_LEVELS.HIGH,
      replayable: false,
      outward: false,
      requiresCommandCheck: true,
      zodSchema: z.object({
        command: z.string().min(1).describe('要执行的 Shell 命令'),
        cwd: z.string().optional().describe('可选的相对子目录'),
        timeoutMs: z.number().int().min(500).max(120000).optional().describe('超时毫秒数（默认 30000，上限 120000）'),
      }),
      async execute(args, ctx) {
        const command = String(args.command ?? '').trim();
        if (!command) throw new Error('command 不能为空');
        const analysis = analyzeCommand(command);
        if (analysis.hardBlocked) {
          throw new Error(`安全红线拦截：拒绝执行高危命令 (${analysis.hardBlocked})`);
        }
        const cwd = args.cwd
          ? resolveConfinedPath(workspaceRoot, args.cwd).full
          : resolve(workspaceRoot);
        await guardFallback('bash', { command, cwd }, ctx);
        const res = await sandbox.run(command, cwd, {
          timeoutMs: Number(args.timeoutMs ?? 30000),
          signal: ctx?.signal ?? signal,
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
    }),

    defineTool({
      name: 'start_process',
      description:
        '在后台启动长驻进程（如 dev server / 文件监听器 / 长耗时构建），返回 processId 供后续 read_process_output 与 kill_process 管理。',
      effectClass: EFFECT_CLASSES.IRREVERSIBLE_SIDE_EFFECT,
      riskLevel: RISK_LEVELS.HIGH,
      replayable: false,
      outward: false,
      requiresCommandCheck: true,
      zodSchema: z.object({
        command: z.string().min(1).describe('要启动的后台命令'),
        cwd: z.string().optional().describe('可选的相对子目录'),
      }),
      async execute(args, ctx) {
        const command = String(args.command ?? '').trim();
        if (!command) throw new Error('command 不能为空');
        const analysis = analyzeCommand(command);
        if (analysis.hardBlocked) {
          throw new Error(`安全红线拦截：拒绝启动高危命令 (${analysis.hardBlocked})`);
        }
        const cwd = args.cwd
          ? resolveConfinedPath(workspaceRoot, args.cwd).full
          : resolve(workspaceRoot);
        await guardFallback('start_process', { command, cwd }, ctx);
        const proc = bgProcs.start(command, cwd);
        return `已启动后台进程 ${proc.id} (${command})。可用 read_process_output 查看实时日志，或用 kill_process 停止。`;
      },
    }),

    defineTool({
      name: 'read_process_output',
      description: '读取后台进程最近的运行状态与日志输出。',
      effectClass: EFFECT_CLASSES.READ_ONLY,
      riskLevel: RISK_LEVELS.LOW,
      replayable: true,
      outward: false,
      zodSchema: z.object({
        processId: z.string().min(1).describe('start_process 返回的进程 ID'),
        tailChars: z.number().int().min(100).max(32000).optional().describe('尾部最大字符数（默认 8000）'),
      }),
      async execute(args, ctx) {
        await guardFallback('read_process_output', args, ctx);
        const info = bgProcs.read(String(args.processId ?? ''), {
          tailChars: args.tailChars,
        });
        if (!info) return `未找到后台进程: ${args.processId}`;
        return wrapResult(
          'read_process_output',
          `processId: ${info.id} | running: ${info.running} | exitCode: ${info.exitCode}\n${info.output || '(暂无输出)'}`,
        );
      },
    }),

    defineTool({
      name: 'kill_process',
      description: '终止通过 start_process 启动的后台进程。',
      effectClass: EFFECT_CLASSES.IRREVERSIBLE_SIDE_EFFECT,
      riskLevel: RISK_LEVELS.MEDIUM,
      replayable: false,
      outward: false,
      zodSchema: z.object({
        processId: z.string().min(1).describe('要停止的后台进程 ID'),
      }),
      async execute(args, ctx) {
        await guardFallback('kill_process', { processId: args.processId }, ctx);
        const ok = bgProcs.kill(String(args.processId ?? ''));
        return ok ? `已停止后台进程 ${args.processId}` : `未找到后台进程 ${args.processId}`;
      },
    }),
  ];
}
