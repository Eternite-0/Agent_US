import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { UNTRUSTED_RULE_SECTION } from './envelope.js';
import { killProcessTree, sanitizeChildEnv } from './tools/sandbox.js';
import { HookTrustManager, normalizeHookConfigPath } from './tools/hook-trust.js';

const INSTRUCTION_FILENAMES = [
  'AGENTS.md',
  'AGENTS.override.md',
  'CLAUDE.md',
  join('.claude', 'CLAUDE.md'),
];

const DEFAULT_PROJECT_DOC_BUDGET = 32 * 1024;
const MAX_SKILL_FILES = 16;

// Agnes Harness-inspired deterministic ordered Prompt Section Registry.
// Static sections NEVER interpolate cwd / branch / timestamp / model id so
// provider Prompt Cache stays byte-identical across turns and model switches.
const STATIC_SECTION_SPECS = Object.freeze([
  {
    id: 'identity',
    order: 10,
    render: () =>
      [
        '你是 Agent_US 的工程级 AI 编程与任务助手，风格对齐 Claude Code 与 Codex：直接、务实、准确、用中文（除非用户要求其他语言）给出清晰结论。',
        '不要编造未实际读取的文件内容、未执行的命令输出或未验证的测试结果；遇到权限或客观阻塞时如实说明并停止。',
      ].join('\n'),
  },
  {
    id: 'coding-doctrine',
    order: 20,
    render: () =>
      [
        '核心工程准则：',
        '1. **自然对话优先**：对于简单问候、概念问答、代码思路探讨，直接用自然语言清晰作答，不无故调用工具。',
        '2. **先读后改（Read-Before-Edit）**：修改任意现有文件前先用 `read_file` 或 `grep` 核对真实上下文与行号；多文件/多处改动优先使用 `apply_patch`（一次原子提交），单处小改用 `edit_file`，新建/覆写整文件用 `write_file`。',
        '3. **并发调研**：需要同时查看多个文件或执行多个搜索时，在同一轮中批量发出多个只读工具调用（`read_file`/`glob`/`grep`/`search_history`），运行时会自动并发加速。',
        '4. **任务清单与闭环验证**：多步骤工程任务可用 `update_plan` 维护简洁进度清单；修改代码后检查自动语法诊断并运行相关构建/测试确认无报错再收尾；若 `bash` 命令返回非 0 退出码，先定位根因再继续。',
        '5. **路径规范**：工具路径优先使用相对工作区根目录的路径（例如 `src/index.js`）。',
      ].join('\n'),
  },
  {
    id: 'untrusted-envelope',
    order: 90,
    render: ({ nonce }) =>
      UNTRUSTED_RULE_SECTION.replace(/\{\{NONCE\}\}/g, nonce),
  },
]);

export function buildStaticSystemPrompt(nonce) {
  const ordered = [...STATIC_SECTION_SPECS].sort((a, b) => a.order - b.order);
  return ordered.map((s) => s.render({ nonce })).join('\n\n');
}

function findProjectRoot(startDir) {
  let cur = resolve(startDir);
  while (true) {
    if (existsSync(join(cur, '.git'))) return cur;
    const parent = dirname(cur);
    if (parent === cur) return resolve(startDir);
    cur = parent;
  }
}

/**
 * Codex `agents_md.rs` + Claude Code `CLAUDE.md` hierarchical project doc discovery.
 * Walks from git root down to `workspaceRoot`, collecting AGENTS.md / AGENTS.override.md / CLAUDE.md
 * within a strict UTF-8 byte budget so large repos cannot blow up context.
 */
export function discoverProjectInstructions(
  workspaceRoot,
  { maxBytes = DEFAULT_PROJECT_DOC_BUDGET } = {},
) {
  const cwd = resolve(workspaceRoot);
  if (!existsSync(cwd)) return { files: [], text: '', truncated: false };
  const gitRoot = findProjectRoot(cwd);

  // Build ancestor chain from gitRoot -> cwd (inclusive)
  const chain = [];
  let cur = cwd;
  while (true) {
    chain.unshift(cur);
    if (cur === gitRoot) break;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }

  let remaining = maxBytes;
  const files = [];
  const chunks = [];
  let truncated = false;

  for (const dir of chain) {
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    for (const relName of INSTRUCTION_FILENAMES) {
      const full = join(dir, relName);
      if (!existsSync(full)) continue;
      try {
        const st = statSync(full);
        if (!st.isFile() || st.size === 0) continue;
        let raw = readFileSync(full, 'utf8').trim();
        if (!raw) continue;
        const bytes = Buffer.byteLength(raw, 'utf8');
        if (bytes > remaining) {
          raw = raw.slice(0, Math.max(256, Math.floor(remaining * 0.75))) + '\n[... truncated by project_doc_max_bytes ...]';
          truncated = true;
          remaining = 0;
        } else {
          remaining -= bytes;
        }
        const displayPath = relative(gitRoot, full).replace(/\\/g, '/') || relName;
        files.push(displayPath);
        chunks.push(`### ${displayPath}\n${raw}`);
      } catch {
        // skip unreadable instruction file
      }
    }
  }

  return {
    files,
    text: chunks.join('\n\n--- project-doc ---\n\n'),
    truncated,
  };
}

function stripFrontmatter(text) {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n/, '');
}

/**
 * Discovers workspace MEMORY.md, SQLite nexus_memory, and local SKILL.md catalog.
 */
export function discoverMemoryAndSkills(workspaceRoot, store, { dataRoot = null } = {}) {
  const memoryLines = [];
  const memFile = join(resolve(workspaceRoot), '.agent-us', 'MEMORY.md');
  if (existsSync(memFile)) {
    try {
      const body = readFileSync(memFile, 'utf8').trim();
      if (body) memoryLines.push(`#### .agent-us/MEMORY.md\n${body.slice(0, 6000)}`);
    } catch {
      // ignore
    }
  }
  if (store?.db) {
    try {
      const rows = store.db
        .prepare(
          `SELECT scopeType, key, value FROM nexus_memory
           WHERE scopeType='global' OR (scopeType='workspace' AND scopeId=?)
           ORDER BY updatedAt DESC LIMIT 12`,
        )
        .all(resolve(workspaceRoot));
      for (const r of rows) {
        memoryLines.push(`- [${r.scopeType}] **${r.key}**: ${String(r.value).slice(0, 400)}`);
      }
    } catch {
      // ignore
    }
  }

  // Discover SKILL.md files from workspace `.agent-us/skills` & dataRoot `skills`
  const skillDirs = [
    join(resolve(workspaceRoot), '.agent-us', 'skills'),
    ...(dataRoot ? [join(resolve(dataRoot), 'skills'), join(resolve(dataRoot), 'extensions', 'skills')] : []),
  ];
  const skills = [];
  for (const dir of skillDirs) {
    if (!existsSync(dir)) continue;
    try {
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        if (skills.length >= MAX_SKILL_FILES) break;
        const skillPath = ent.isDirectory()
          ? join(dir, ent.name, 'SKILL.md')
          : ent.name.endsWith('.md')
            ? join(dir, ent.name)
            : null;
        if (!skillPath || !existsSync(skillPath)) continue;
        const raw = readFileSync(skillPath, 'utf8');
        const nameMatch = /^name:\s*(.+)$/m.exec(raw);
        const descMatch = /^description:\s*(.+)$/m.exec(raw);
        const name = (nameMatch?.[1] ?? ent.name.replace(/\.md$/, '')).trim();
        const desc = (
          descMatch?.[1] ??
          stripFrontmatter(raw).trim().split(/\r?\n/)[0] ??
          ''
        )
          .trim()
          .slice(0, 180);
        skills.push(`- **${name}** (${skillPath}): ${desc}`);
      }
    } catch {
      // ignore
    }
  }

  return {
    memoryText: memoryLines.join('\n'),
    skillsText: skills.join('\n'),
  };
}

export function buildRuntimeContextMessage({
  workspaceRoot,
  gitBranch = null,
  mode = 'direct',
  permissionMode = 'auto-safe',
  projectInstructions = null,
  memoryText = '',
  skillsText = '',
  planState = null,
  hookContexts = [],
}) {
  const parts = [
    '<runtime_context>',
    `workspaceRoot: ${workspaceRoot}`,
    `platform: ${process.platform} (${process.arch})`,
    `permissionMode: ${permissionMode}`,
    `mode: ${mode}`,
    ...(gitBranch ? [`gitBranch: ${gitBranch}`] : []),
    '</runtime_context>',
  ];

  if (mode === 'plan') {
    parts.push(
      '[PLAN 模式] 当前处于 `/plan` 规划模式：先只读调研关键代码并输出清晰的分步实施计划，等待用户确认后再修改文件或运行破坏性命令。',
    );
  }
  if (projectInstructions?.text) {
    parts.push(`<project_instructions>\n${projectInstructions.text}\n</project_instructions>`);
  }
  if (memoryText) {
    parts.push(`<workspace_memory>\n${memoryText}\n</workspace_memory>`);
  }
  if (skillsText) {
    parts.push(
      `<available_skills>\n当任务匹配以下技能时，可先用 read_file 阅读对应 SKILL.md：\n${skillsText}\n</available_skills>`,
    );
  }
  if (planState?.steps?.length) {
    const lines = planState.steps.map(
      (s) => `- [${s.status === 'completed' ? 'x' : s.status === 'in_progress' ? '/' : ' '}] ${s.title}`,
    );
    parts.push(`<active_plan>\n${lines.join('\n')}\n</active_plan>`);
  }
  for (const ctx of hookContexts) {
    if (ctx) parts.push(`<hook_context>\n${ctx}\n</hook_context>`);
  }
  return parts.join('\n\n');
}

// ---- Deterministic Lifecycle Hooks (Claude Code + Codex hook_runtime.rs) ----

function parseHooksBuffer(rawBuffer) {
  try {
    const parsed = JSON.parse(rawBuffer.toString('utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function runShellHook(
  command,
  payload,
  cwd,
  { timeoutMs = 10000, maxTimeoutMs = 15000, signal = undefined } = {},
) {
  return new Promise((resolveHook) => {
    if (signal?.aborted) {
      resolveHook({
        exitCode: 130,
        stdout: '',
        stderr: '[hook aborted]',
        aborted: true,
        timedOut: false,
      });
      return;
    }

    const isWin = process.platform === 'win32';
    const child = spawn(command, {
      cwd,
      shell: true,
      windowsHide: true,
      detached: !isWin,
      env: sanitizeChildEnv(process.env),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let done = false;

    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };

    const effectiveTimeout = Math.min(
      Math.max(500, Number(maxTimeoutMs || 15000)),
      Math.max(100, Number(timeoutMs || 10000)),
    );
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      cleanup();
      killProcessTree(child);
      resolveHook({
        exitCode: 124,
        stdout,
        stderr: `${stderr}\n[hook timeout]`.trim(),
        aborted: false,
        timedOut: true,
      });
    }, effectiveTimeout);

    const onAbort = () => {
      if (done) return;
      done = true;
      cleanup();
      killProcessTree(child);
      resolveHook({
        exitCode: 130,
        stdout,
        stderr: `${stderr}\n[hook aborted]`.trim(),
        aborted: true,
        timedOut: false,
      });
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (c) => {
      if (stdout.length < 32768) stdout += c.toString('utf8');
    });
    child.stderr.on('data', (c) => {
      if (stderr.length < 16384) stderr += c.toString('utf8');
    });
    child.on('error', (err) => {
      if (done) return;
      done = true;
      cleanup();
      resolveHook({
        exitCode: 1,
        stdout,
        stderr: String(err?.message ?? err),
        aborted: false,
        timedOut: false,
      });
    });
    child.on('close', (code) => {
      if (done) return;
      done = true;
      cleanup();
      resolveHook({
        exitCode: code ?? 0,
        stdout,
        stderr,
        aborted: false,
        timedOut: false,
      });
    });
    try {
      child.stdin.write(JSON.stringify(payload));
      child.stdin.end();
    } catch {
      // ignore broken pipe
    }
  });
}

export class HookRunner {
  constructor(
    workspaceRoot,
    { dataRoot = null, store = null, trustManager = null, eventRouter = null } = {},
  ) {
    this.workspaceRoot = resolve(workspaceRoot);
    this.dataRoot = dataRoot ? resolve(dataRoot) : null;
    this.trustManager = trustManager ?? new HookTrustManager({ store, eventRouter });
  }

  #getCandidateHookFiles() {
    const raw = [
      ...(this.dataRoot ? [join(this.dataRoot, 'hooks.json')] : []),
      join(this.workspaceRoot, '.agent-us', 'hooks.json'),
    ];
    const seen = new Set();
    const out = [];
    for (const p of raw) {
      const norm = normalizeHookConfigPath(p);
      if (seen.has(norm)) continue;
      seen.add(norm);
      out.push(p);
    }
    return out;
  }

  #getHandlers(eventName) {
    const handlers = [];
    const skippedUntrusted = [];
    for (const filePath of this.#getCandidateHookFiles()) {
      if (!existsSync(filePath)) continue;
      let readTarget = filePath;
      try {
        readTarget = realpathSync(filePath);
      } catch {
        readTarget = filePath;
      }
      let rawBuffer;
      try {
        rawBuffer = readFileSync(readTarget);
      } catch {
        continue;
      }
      // Enforce explicit SHA-256 content-bound trust boundary for ALL hook configs & ALL hook kinds
      const trust = this.trustManager.verifyFile(filePath, { rawBuffer });
      if (!trust.trusted) {
        skippedUntrusted.push({
          filePath,
          configPath: trust.configPath,
          contentDigest: trust.contentDigest,
          reason: trust.reason,
        });
        continue;
      }
      const src = parseHooksBuffer(rawBuffer);
      const list = src?.[eventName];
      if (!Array.isArray(list)) continue;
      for (const item of list) {
        if (item && typeof item.command === 'string' && item.command.trim()) {
          handlers.push({
            ...item,
            __rawFilePath: filePath,
            __sourcePath: trust.configPath,
            __contentDigest: trust.contentDigest,
          });
        }
      }
    }
    return { handlers, skippedUntrusted };
  }

  #resolveHookKind(eventName, item) {
    const raw = String(item?.kind ?? '').toLowerCase();
    if (raw === 'security' || raw === 'transform' || raw === 'observation') return raw;
    return eventName === 'PreToolUse' ? 'security' : 'observation';
  }

  async run(
    eventName,
    payload = {},
    { signal = undefined, permissionMode = null, maxTimeoutMs = 15000 } = {},
  ) {
    const { handlers, skippedUntrusted } = this.#getHandlers(eventName);
    if (!handlers.length) {
      return {
        blocked: false,
        reason: null,
        hookKind: null,
        updatedInput: null,
        transformApplied: false,
        additionalContexts: [],
        warnings: [],
        skippedUntrusted,
      };
    }
    const toolName = String(payload.tool ?? '');
    const additionalContexts = [];
    const warnings = [];
    let updatedInput = null;
    let transformApplied = false;

    for (const h of handlers) {
      if (signal?.aborted) {
        if (eventName === 'PreToolUse') {
          signal.throwIfAborted?.();
        }
        break;
      }
      if (h.matcher) {
        try {
          if (!new RegExp(String(h.matcher)).test(toolName)) continue;
        } catch {
          if (String(h.matcher) !== toolName) continue;
        }
      }
      const kind = this.#resolveHookKind(eventName, h);
      // Re-verify exact disk bytes & trust DB immediately before spawning EACH handler (closes multi-handler TOCTOU)
      const liveSourcePath = h.__rawFilePath || h.__sourcePath;
      if (liveSourcePath && h.__contentDigest) {
        const liveTrust = this.trustManager.verifyFile(liveSourcePath);
        if (!liveTrust.trusted || liveTrust.contentDigest !== h.__contentDigest) {
          const modified = liveTrust.exists && liveTrust.contentDigest !== h.__contentDigest;
          const reasonCode = !liveTrust.exists
            ? 'HOOK_CONFIG_DELETED_BEFORE_EXEC'
            : modified
              ? 'HOOK_CONFIG_MODIFIED_BEFORE_EXEC'
              : 'HOOK_TRUST_REVOKED_BEFORE_EXEC';
          const reasonMsg = !liveTrust.exists
            ? `Hook 配置文件在执行前被删除 (${h.__sourcePath})`
            : modified
              ? `Hook 配置文件在执行前已被修改 (${h.__sourcePath})`
              : `Hook 配置信任在执行前已被撤销 (${h.__sourcePath})`;
          skippedUntrusted.push({
            filePath: liveSourcePath,
            configPath: liveTrust.configPath,
            contentDigest: liveTrust.contentDigest,
            reason: reasonCode,
          });
          warnings.push(reasonMsg);
          if (kind === 'security' || kind === 'transform') {
            return {
              blocked: true,
              failClosed: true,
              hookKind: kind,
              reason: `${reasonCode}: ${reasonMsg}`,
              updatedInput: null,
              transformApplied: false,
              additionalContexts,
              warnings,
              skippedUntrusted,
            };
          }
          continue;
        }
      }
      const currentPayload = updatedInput
        ? { ...payload, arguments: updatedInput }
        : payload;
      const res = await runShellHook(
        h.command,
        {
          event: eventName,
          hookKind: kind,
          workspaceRoot: this.workspaceRoot,
          ...(permissionMode ? { permissionMode } : {}),
          ...currentPayload,
        },
        this.workspaceRoot,
        {
          timeoutMs: Number(h.timeoutMs ?? 10000),
          maxTimeoutMs,
          signal,
        },
      );

      if (res.aborted) {
        if (eventName === 'PreToolUse') {
          signal?.throwIfAborted?.();
        }
        warnings.push(`Hook (${eventName}) 已取消`);
        break;
      }

      let parsed = null;
      const trimmedOut = res.stdout.trim();
      if (trimmedOut.startsWith('{') && trimmedOut.endsWith('}')) {
        try {
          parsed = JSON.parse(trimmedOut);
        } catch {
          parsed = null;
        }
      }

      if (kind === 'security') {
        if (
          res.exitCode !== 0 ||
          parsed?.decision === 'block' ||
          parsed?.decision === 'deny'
        ) {
          return {
            blocked: true,
            failClosed: true,
            hookKind: 'security',
            reason:
              parsed?.reason ||
              res.stderr.trim() ||
              trimmedOut ||
              `安全 Hook (${eventName}) 失败或拦截 (exit=${res.exitCode})`,
            updatedInput: null,
            transformApplied: false,
            additionalContexts,
            warnings,
            skippedUntrusted,
          };
        }
        if (typeof parsed?.additionalContext === 'string' && parsed.additionalContext.trim()) {
          additionalContexts.push(parsed.additionalContext.trim().slice(0, 4096));
        }
        continue;
      }

      if (kind === 'transform') {
        if (res.exitCode !== 0 || parsed?.decision === 'block' || parsed?.decision === 'deny') {
          return {
            blocked: true,
            failClosed: true,
            hookKind: 'transform',
            reason:
              parsed?.reason ||
              res.stderr.trim() ||
              trimmedOut ||
              `参数变换 Hook (${eventName}) 失败 (exit=${res.exitCode})`,
            updatedInput: null,
            transformApplied: false,
            additionalContexts,
            warnings,
            skippedUntrusted,
          };
        }
        if (parsed?.updatedInput !== undefined) {
          if (
            !parsed.updatedInput ||
            typeof parsed.updatedInput !== 'object' ||
            Array.isArray(parsed.updatedInput)
          ) {
            return {
              blocked: true,
              failClosed: true,
              hookKind: 'transform',
              reason: `参数变换 Hook 返回非对象 updatedInput`,
              updatedInput: null,
              transformApplied: false,
              additionalContexts,
              warnings,
              skippedUntrusted,
            };
          }
          updatedInput = parsed.updatedInput;
          transformApplied = true;
        }
        if (typeof parsed?.additionalContext === 'string' && parsed.additionalContext.trim()) {
          additionalContexts.push(parsed.additionalContext.trim().slice(0, 4096));
        }
        continue;
      }

      // Observation hook: cannot block, cannot mutate inputs, cannot grant authorization,
      // and receives ZERO extra execution privileges (same trust, env sanitization, signal, timeout).
      if (res.exitCode !== 0) {
        warnings.push(
          `观察型 Hook (${eventName}) 返回非零退出码 ${res.exitCode}: ${(res.stderr || trimmedOut).slice(0, 200)}`,
        );
      }
      if (typeof parsed?.additionalContext === 'string' && parsed.additionalContext.trim()) {
        additionalContexts.push(parsed.additionalContext.trim().slice(0, 4096));
      } else if (res.exitCode === 0 && trimmedOut && !parsed) {
        additionalContexts.push(trimmedOut.slice(0, 2048));
      }
    }

    return {
      blocked: false,
      reason: null,
      hookKind: null,
      updatedInput,
      transformApplied,
      additionalContexts,
      warnings,
      skippedUntrusted,
    };
  }
}
