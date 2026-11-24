import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { redactSecrets, UNTRUSTED_RULE_SECTION } from './envelope.js';
import { killProcessTree, sanitizeChildEnv } from './tools/sandbox.js';
import { HookTrustManager, normalizeHookConfigPath } from './tools/hook-trust.js';

const INSTRUCTION_FILENAMES = [
  'AGENTS.md',
  'AGENTS.override.md',
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
        '核心工程准则（简单问候、概念问答或纯思路探讨直接用自然语言清晰作答，不无故调用工具；工具路径优先使用相对工作区根目录路径）：',
        '1. **精准定位**：先用 `inspect_repository` / `query_symbol_graph` / `grep` / `glob` 定位入口、符号定义与调用链；需要查看多处位置时在同一轮并发调用只读工具，复杂多步任务用 `update_plan` 维护简洁进度清单。',
        '2. **先读后改**：修改任意现有文件前先用 `read_file` 核对真实上下文与行号，绝不凭记忆盲改。',
        '3. **最小原子修改**：单文件局部修改首选 `edit_file`（`target` 复制真实代码上下文且不带行号前缀）；跨多文件或多处不连续 hunk 的原子修改用 `apply_patch`；新建或整文件覆写才用 `write_file`。',
        '4. **测试闭环与根因复盘**：改完检查自动语法诊断并运行 `run_diagnostics` 或相关测试/构建命令确认通过；若返回错误或测试失败，先定位根因再修复，不要重试无效修改；收尾前执行 `git diff` 与 `git status` 自检无多余改动或临时文件。',
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
 * Agent_US native hierarchical project doc & rule discovery.
 * Reads ONLY Agent_US native assets (`<dataRoot>/rules/*.md`, `AGENTS.md`,
 * `AGENTS.override.md`, and `.agent-us/rules/*.md`) within a strict UTF-8 byte budget.
 * Never silently reads `.claude/` or `~/.codex/` without explicit user import.
 */
export function discoverProjectInstructions(
  workspaceRoot,
  { maxBytes = DEFAULT_PROJECT_DOC_BUDGET, dataRoot = null } = {},
) {
  const cwd = resolve(workspaceRoot);
  const gitRoot = existsSync(cwd) ? findProjectRoot(cwd) : cwd;

  // Build ancestor chain from gitRoot -> cwd (inclusive)
  const chain = [];
  if (existsSync(cwd)) {
    let cur = cwd;
    while (true) {
      chain.unshift(cur);
      if (cur === gitRoot) break;
      const parent = dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  }

  let remaining = maxBytes;
  const files = [];
  const chunks = [];
  let truncated = false;

  const appendRuleFile = (fullPath, displayPath) => {
    if (remaining <= 0) {
      truncated = true;
      return;
    }
    if (!existsSync(fullPath)) return;
    try {
      const st = statSync(fullPath);
      if (!st.isFile() || st.size === 0) return;
      let raw = readFileSync(fullPath, 'utf8').trim();
      if (!raw) return;
      const bytes = Buffer.byteLength(raw, 'utf8');
      if (bytes > remaining) {
        raw =
          raw.slice(0, Math.max(256, Math.floor(remaining * 0.75))) +
          '\n[... truncated by project_doc_max_bytes ...]';
        truncated = true;
        remaining = 0;
      } else {
        remaining -= bytes;
      }
      files.push(displayPath);
      chunks.push(`### ${displayPath}\n${raw}`);
    } catch {
      // skip unreadable instruction file
    }
  };

  // 1. User-scope native rules under <dataRoot>/rules/*.md
  if (dataRoot) {
    const userRulesDir = join(resolve(dataRoot), 'rules');
    if (existsSync(userRulesDir)) {
      try {
        const entries = readdirSync(userRulesDir, { withFileTypes: true })
          .filter((ent) => ent.isFile() && ent.name.toLowerCase().endsWith('.md'))
          .sort((a, b) => a.name.localeCompare(b.name));
        for (const ent of entries) {
          appendRuleFile(join(userRulesDir, ent.name), `~/.agent-us/rules/${ent.name}`);
          if (remaining <= 0) break;
        }
      } catch {
        // skip unreadable user rules dir
      }
    }
  }

  // 2. Workspace ancestor chain: AGENTS.md, AGENTS.override.md, and .agent-us/rules/*.md
  for (const dir of chain) {
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    for (const relName of INSTRUCTION_FILENAMES) {
      const full = join(dir, relName);
      const displayPath = relative(gitRoot, full).replace(/\\/g, '/') || relName;
      appendRuleFile(full, displayPath);
      if (remaining <= 0) break;
    }
    if (remaining <= 0) break;
    const wsRulesDir = join(dir, '.agent-us', 'rules');
    if (existsSync(wsRulesDir)) {
      try {
        const entries = readdirSync(wsRulesDir, { withFileTypes: true })
          .filter((ent) => ent.isFile() && ent.name.toLowerCase().endsWith('.md'))
          .sort((a, b) => a.name.localeCompare(b.name));
        for (const ent of entries) {
          const full = join(wsRulesDir, ent.name);
          const displayPath = relative(gitRoot, full).replace(/\\/g, '/');
          appendRuleFile(full, displayPath);
          if (remaining <= 0) break;
        }
      } catch {
        // skip unreadable workspace rules dir
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
  const extensionSkillDir = dataRoot ? join(resolve(dataRoot), 'extensions', 'skills') : null;
  const skillDirs = [
    join(resolve(workspaceRoot), '.agent-us', 'skills'),
    ...(dataRoot ? [join(resolve(dataRoot), 'skills'), extensionSkillDir] : []),
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
        // The bundled office workflows live outside the workspace tool sandbox.
        // Supply their bounded instructions here without granting arbitrary file access.
        if (dir === extensionSkillDir && /^office-(documents|pdf|spreadsheets|presentations)$/.test(ent.name)) {
          skills.push(`- **${name}** (installed office workflow): ${desc}\n${stripFrontmatter(raw).trim().slice(0, 1800)}`);
        } else {
          skills.push(`- **${name}** (${skillPath}): ${desc}`);
        }
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
  repoSummary = '',
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
  const trimmedRepoSummary = typeof repoSummary === 'string' ? repoSummary.trim() : '';
  if (trimmedRepoSummary) {
    parts.push(`<repository_intelligence>\n${trimmedRepoSummary}\n</repository_intelligence>`);
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

// ---- Native Customizations, Slash Command Expansion & Explicit External Onboarding ----

const BUILTIN_SLASH_COMMANDS = new Set([
  'plan',
  'swarm',
  'compact',
  'undo',
  'rewind',
  'import',
  'git',
  'steer',
  'help',
  'exit',
  'commands',
]);

const SECRET_KEY_RE =
  /(?:token|secret|key|password|passwd|auth|cookie|credential|bearer|private)/i;

function parseFrontmatterField(rawText, field) {
  const fmMatch = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(rawText ?? ''));
  if (!fmMatch) return '';
  const rx = new RegExp(`^${field}:\\s*(.+)$`, 'mi');
  const m = rx.exec(fmMatch[1]);
  if (!m) return '';
  return m[1].trim().replace(/^['"]|['"]$/g, '');
}

function summarizeMarkdownText(rawText, maxLen = 140) {
  const clean = redactSecrets(stripFrontmatter(String(rawText ?? '')).trim());
  const firstLine = clean
    .split(/\r?\n/)
    .map((l) => l.replace(/^#+\s*/, '').trim())
    .find(Boolean);
  return (firstLine || '').slice(0, maxLen);
}

function walkMarkdownFiles(baseDir, maxFiles = 128) {
  const results = [];
  if (!baseDir || !existsSync(baseDir)) return results;
  const walk = (dir) => {
    if (results.length >= maxFiles) return;
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
        a.name.localeCompare(b.name),
      );
    } catch {
      return;
    }
    for (const ent of entries) {
      if (results.length >= maxFiles) break;
      if (ent.name === 'node_modules' || ent.name === '.git') continue;
      const full = join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(full);
      } else if (ent.isFile() && ent.name.toLowerCase().endsWith('.md')) {
        const rel = relative(baseDir, full).replace(/\\/g, '/');
        results.push({ full, rel });
      }
    }
  };
  walk(baseDir);
  return results;
}

function safeSlug(input, fallback = 'item') {
  const clean = String(input ?? '')
    .trim()
    .replace(/\.md$/i, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return clean || fallback;
}

function sanitizeImportedRelPath(relPath, fallback = 'command.md') {
  const segments = String(relPath ?? '')
    .replace(/\\/g, '/')
    .split('/')
    .filter((seg) => seg && seg !== '.' && seg !== '..');
  if (!segments.length) return fallback;
  const cleaned = segments.map((s) => s.replace(/[^A-Za-z0-9._-]/g, '-'));
  const last = cleaned[cleaned.length - 1];
  if (!last.toLowerCase().endsWith('.md')) {
    cleaned[cleaned.length - 1] = `${last}.md`;
  }
  return cleaned.join('/');
}

function redactSecretValueMap(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const str = String(v ?? '');
    out[k] = SECRET_KEY_RE.test(k) ? '[REDACTED]' : redactSecrets(str);
  }
  return out;
}

function stripTomlInlineComment(val) {
  let quote = null;
  for (let i = 0; i < val.length; i++) {
    const ch = val[i];
    if (quote) {
      if (ch === '\\' && quote === '"' && i + 1 < val.length) {
        i++;
        continue;
      }
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '#' && (i === 0 || /\s/.test(val[i - 1]))) {
      return val.slice(0, i).trim();
    }
  }
  return val.trim();
}

function sanitizeMcpEntryForStorage(rawCfg, { sourceLabel = '' } = {}) {
  if (!rawCfg || typeof rawCfg !== 'object') return null;
  const hasCommand = typeof rawCfg.command === 'string' && rawCfg.command.trim();
  const hasUrl = typeof rawCfg.url === 'string' && rawCfg.url.trim();
  if (!hasCommand && !hasUrl) return null;

  const entry = {};
  if (hasCommand) {
    entry.command = redactSecrets(rawCfg.command.trim());
    entry.args = Array.isArray(rawCfg.args)
      ? rawCfg.args.map((a) => redactSecrets(String(a)))
      : [];
  }
  if (hasUrl) {
    entry.url = redactSecrets(rawCfg.url.trim());
  }
  if (rawCfg.env && typeof rawCfg.env === 'object' && !Array.isArray(rawCfg.env)) {
    entry.env = redactSecretValueMap(rawCfg.env);
  }
  if (rawCfg.headers && typeof rawCfg.headers === 'object' && !Array.isArray(rawCfg.headers)) {
    entry.headers = redactSecretValueMap(rawCfg.headers);
  }
  entry.disabled = true;
  entry.trusted = false;
  if (sourceLabel) entry.importedFrom = sourceLabel;
  entry.importedAt = Date.now();
  return entry;
}

function formatRedactedMcpSummary(name, rawCfg) {
  const transport = rawCfg?.command ? 'stdio' : rawCfg?.url ? 'http' : 'unknown';
  const target = rawCfg?.command
    ? [rawCfg.command, ...(Array.isArray(rawCfg.args) ? rawCfg.args : [])]
        .map((s) => redactSecrets(String(s)))
        .join(' ')
    : redactSecrets(String(rawCfg?.url ?? ''));
  const envKeys =
    rawCfg?.env && typeof rawCfg.env === 'object' ? Object.keys(rawCfg.env) : [];
  const headerKeys =
    rawCfg?.headers && typeof rawCfg.headers === 'object' ? Object.keys(rawCfg.headers) : [];
  const secretNotes = [
    ...(envKeys.length ? [`env: ${envKeys.join(', ')}=[REDACTED]`] : []),
    ...(headerKeys.length ? [`headers: ${headerKeys.join(', ')}=[REDACTED]`] : []),
  ].join('; ');
  return `${transport}: ${target || name}${secretNotes ? ` (${secretNotes})` : ''}`.slice(0, 220);
}

function parseTomlScalarOrArray(rawVal) {
  const s = String(rawVal ?? '').trim();
  if (!s) return '';
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim();
    if (!inner) return [];
    const out = [];
    let cur = '';
    let quote = null;
    for (let i = 0; i < inner.length; i++) {
      const ch = inner[i];
      if (quote) {
        if (ch === '\\' && quote === '"' && i + 1 < inner.length) {
          cur += inner[++i];
          continue;
        }
        if (ch === quote) {
          quote = null;
          continue;
        }
        cur += ch;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === ',') {
        if (cur.trim()) out.push(cur.trim());
        cur = '';
      } else {
        cur += ch;
      }
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  }
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    return s.slice(1, -1);
  }
  return s;
}

function parseCodexTomlConfig(rawToml) {
  const servers = {};
  let instructions = '';
  const lines = String(rawToml ?? '').split(/\r?\n/);
  let currentSection = '';
  let multilineKey = null;
  let multilineQuote = null;
  let multilineBuf = [];

  for (const rawLine of lines) {
    if (multilineKey) {
      const endIdx = rawLine.indexOf(multilineQuote);
      if (endIdx >= 0) {
        multilineBuf.push(rawLine.slice(0, endIdx));
        const joined = multilineBuf.join('\n').trim();
        if (!currentSection && (multilineKey === 'instructions' || multilineKey === 'developer_instructions')) {
          instructions = instructions ? `${instructions}\n${joined}` : joined;
        }
        multilineKey = null;
        multilineQuote = null;
        multilineBuf = [];
      } else {
        multilineBuf.push(rawLine);
      }
      continue;
    }
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const secMatch = /^\[([^\]]+)\]$/.exec(line);
    if (secMatch) {
      currentSection = secMatch[1].trim();
      continue;
    }
    const kvMatch = /^([A-Za-z0-9_.-]+|"[^"]+"|'[^']+')\s*=\s*(.+)$/.exec(line);
    if (!kvMatch) continue;
    const rawKey = kvMatch[1].replace(/^['"]|['"]$/g, '');
    const rawVal = stripTomlInlineComment(kvMatch[2]);
    if (rawVal.startsWith('"""') || rawVal.startsWith("'''")) {
      const q3 = rawVal.slice(0, 3);
      const rest = rawVal.slice(3);
      const endIdx = rest.indexOf(q3);
      if (endIdx >= 0) {
        const val = rest.slice(0, endIdx).trim();
        if (!currentSection && (rawKey === 'instructions' || rawKey === 'developer_instructions')) {
          instructions = instructions ? `${instructions}\n${val}` : val;
        }
      } else {
        multilineKey = rawKey;
        multilineQuote = q3;
        multilineBuf = [rest];
      }
      continue;
    }
    const parsedVal = parseTomlScalarOrArray(rawVal);
    if (!currentSection && (rawKey === 'instructions' || rawKey === 'developer_instructions')) {
      if (typeof parsedVal === 'string' && parsedVal.trim()) {
        instructions = instructions ? `${instructions}\n${parsedVal.trim()}` : parsedVal.trim();
      }
      continue;
    }
    const mcpMatch = /^mcp_servers\.([^.]+)(?:\.(.+))?$/i.exec(currentSection);
    if (mcpMatch) {
      const serverName = mcpMatch[1].replace(/^['"]|['"]$/g, '');
      const subSection = mcpMatch[2]?.replace(/^['"]|['"]$/g, '') ?? '';
      servers[serverName] ??= {};
      if (!subSection) {
        if (rawKey === 'env' && rawVal.startsWith('{') && rawVal.endsWith('}')) {
          servers[serverName].env = {};
          for (const pair of rawVal.slice(1, -1).split(',')) {
            const pm = /^\s*([^=]+?)\s*=\s*(.+?)\s*$/.exec(pair);
            if (pm) servers[serverName].env[pm[1].replace(/^['"]|['"]$/g, '')] = '[REDACTED]';
          }
        } else {
          servers[serverName][rawKey] = parsedVal;
        }
      } else if (subSection === 'env' || subSection === 'headers') {
        servers[serverName][subSection] ??= {};
        servers[serverName][subSection][rawKey] = '[REDACTED]';
      }
    }
  }
  return { servers, instructions };
}

function readNativeMcpFile(filePath, { scope, source, hookTrust = null, enforceTrust = false } = {}) {
  if (!filePath || !existsSync(filePath)) return [];
  let rawBuffer;
  try {
    rawBuffer = readFileSync(realpathSync(filePath));
  } catch {
    return [];
  }
  let parsed;
  try {
    parsed = JSON.parse(rawBuffer.toString('utf8'));
  } catch {
    return [];
  }
  const map = parsed?.mcpServers ?? parsed?.servers ?? {};
  if (!map || typeof map !== 'object') return [];
  const fileTrusted = enforceTrust
    ? Boolean(hookTrust?.verifyFile?.(filePath, { rawBuffer })?.trusted)
    : true;
  const out = [];
  for (const [name, cfg] of Object.entries(map)) {
    if (!cfg || typeof cfg !== 'object') continue;
    const isArr = Array.isArray(cfg);
    const command = isArr ? String(cfg[0] ?? '') : typeof cfg.command === 'string' ? cfg.command : '';
    const args = isArr
      ? cfg.slice(1).map(String)
      : Array.isArray(cfg.args)
        ? cfg.args.map(String)
        : [];
    const url = !isArr && typeof cfg.url === 'string' ? cfg.url : null;
    const trusted = enforceTrust ? fileTrusted && cfg.trusted !== false : cfg.trusted !== false && source !== 'mcp-imported.json';
    const disabled =
      source === 'mcp-imported.json'
        ? cfg.disabled !== false
        : Boolean(cfg.disabled) || (enforceTrust && !fileTrusted);
    out.push({
      id: `${scope}:mcp:${name}`,
      name,
      transport: command ? 'stdio' : url ? 'http' : 'stdio',
      command: command ? redactSecrets(command) : null,
      args: args.map((a) => redactSecrets(a)),
      url: url ? redactSecrets(url) : null,
      envKeys: !isArr && cfg.env && typeof cfg.env === 'object' ? Object.keys(cfg.env) : [],
      scope,
      source,
      disabled,
      trusted,
    });
  }
  return out;
}

/**
 * Discovers Agent_US native customizations ONLY (`<dataRoot>` + `<workspaceRoot>/.agent-us` + `AGENTS.md`).
 * Never reads `.claude/` or `~/.codex/` directly.
 */
export function discoverNativeCustomizations(
  workspaceRoot,
  { dataRoot = null, hookTrust = null } = {},
) {
  const ws = resolve(String(workspaceRoot || process.cwd()));
  const data = dataRoot ? resolve(String(dataRoot)) : null;

  const commandMap = new Map();
  const agentMap = new Map();
  const skillMap = new Map();
  const rules = [];
  const mcpServers = [];

  const collectCommands = (dir, scope, displayPrefix) => {
    for (const { full, rel } of walkMarkdownFiles(dir)) {
      try {
        const raw = readFileSync(full, 'utf8');
        const stem = rel.replace(/\.md$/i, '');
        const name = stem.replace(/\//g, ':');
        const fmName = parseFrontmatterField(raw, 'name');
        const effectiveName = fmName || name;
        const description =
          parseFrontmatterField(raw, 'description') || summarizeMarkdownText(raw, 120);
        const argumentHint = parseFrontmatterField(raw, 'argument-hint');
        commandMap.set(effectiveName, {
          id: `${scope}:command:${effectiveName}`,
          name: effectiveName,
          aliases: [...new Set([effectiveName, stem, stem.replace(/\//g, ':')])],
          description: redactSecrets(description),
          argumentHint: redactSecrets(argumentHint),
          scope,
          path: full,
          displayPath: `${displayPrefix}/${rel}`,
          summary: redactSecrets(description || effectiveName),
        });
      } catch {
        // skip unreadable command
      }
    }
  };

  const collectAgents = (dir, scope, displayPrefix) => {
    if (!dir || !existsSync(dir)) return;
    try {
      for (const ent of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
        a.name.localeCompare(b.name),
      )) {
        if (!ent.isFile() || !ent.name.toLowerCase().endsWith('.md')) continue;
        const full = join(dir, ent.name);
        const raw = readFileSync(full, 'utf8');
        const name = parseFrontmatterField(raw, 'name') || ent.name.replace(/\.md$/i, '');
        const description =
          parseFrontmatterField(raw, 'description') || summarizeMarkdownText(raw, 120);
        agentMap.set(name, {
          id: `${scope}:agent:${name}`,
          name,
          description: redactSecrets(description),
          scope,
          path: full,
          displayPath: `${displayPrefix}/${ent.name}`,
          summary: redactSecrets(description || name),
        });
      }
    } catch {
      // skip unreadable agents dir
    }
  };

  const collectSkills = (dir, scope, displayPrefix) => {
    if (!dir || !existsSync(dir)) return;
    try {
      for (const ent of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
        a.name.localeCompare(b.name),
      )) {
        const skillPath = ent.isDirectory()
          ? join(dir, ent.name, 'SKILL.md')
          : ent.isFile() && ent.name.toLowerCase().endsWith('.md')
            ? join(dir, ent.name)
            : null;
        if (!skillPath || !existsSync(skillPath)) continue;
        const raw = readFileSync(skillPath, 'utf8');
        const name = parseFrontmatterField(raw, 'name') || ent.name.replace(/\.md$/i, '');
        const description =
          parseFrontmatterField(raw, 'description') || summarizeMarkdownText(raw, 120);
        const relDisplay = ent.isDirectory() ? `${ent.name}/SKILL.md` : ent.name;
        skillMap.set(name, {
          id: `${scope}:skill:${name}`,
          name,
          description: redactSecrets(description),
          scope,
          path: skillPath,
          displayPath: `${displayPrefix}/${relDisplay}`,
          summary: redactSecrets(description || name),
        });
      }
    } catch {
      // skip unreadable skills dir
    }
  };

  const collectRules = (dir, scope, displayPrefix) => {
    if (!dir || !existsSync(dir)) return;
    try {
      for (const ent of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
        a.name.localeCompare(b.name),
      )) {
        if (!ent.isFile() || !ent.name.toLowerCase().endsWith('.md')) continue;
        const full = join(dir, ent.name);
        const raw = readFileSync(full, 'utf8');
        rules.push({
          id: `${scope}:rule:${ent.name}`,
          name: ent.name.replace(/\.md$/i, ''),
          scope,
          path: full,
          displayPath: `${displayPrefix}/${ent.name}`,
          summary: summarizeMarkdownText(raw, 140),
          bytes: Buffer.byteLength(raw, 'utf8'),
        });
      }
    } catch {
      // skip unreadable rules dir
    }
  };

  // User scope first, then workspace scope (workspace overrides user on name collisions)
  if (data) {
    collectCommands(join(data, 'commands'), 'user', '~/.agent-us/commands');
    collectAgents(join(data, 'agents'), 'user', '~/.agent-us/agents');
    collectSkills(join(data, 'skills'), 'user', '~/.agent-us/skills');
    collectRules(join(data, 'rules'), 'user', '~/.agent-us/rules');
    mcpServers.push(
      ...readNativeMcpFile(join(data, 'mcp.json'), {
        scope: 'user',
        source: 'mcp.json',
      }),
      ...readNativeMcpFile(join(data, 'mcp-imported.json'), {
        scope: 'user',
        source: 'mcp-imported.json',
      }),
    );
  }

  const wsAgentsMd = join(ws, 'AGENTS.md');
  if (existsSync(wsAgentsMd)) {
    try {
      const raw = readFileSync(wsAgentsMd, 'utf8');
      rules.push({
        id: 'workspace:rule:AGENTS.md',
        name: 'AGENTS.md',
        scope: 'workspace',
        path: wsAgentsMd,
        displayPath: 'AGENTS.md',
        summary: summarizeMarkdownText(raw, 140),
        bytes: Buffer.byteLength(raw, 'utf8'),
      });
    } catch {
      // ignore
    }
  }
  const wsDotAgent = join(ws, '.agent-us');
  collectCommands(join(wsDotAgent, 'commands'), 'workspace', '.agent-us/commands');
  collectAgents(join(wsDotAgent, 'agents'), 'workspace', '.agent-us/agents');
  collectSkills(join(wsDotAgent, 'skills'), 'workspace', '.agent-us/skills');
  collectRules(join(wsDotAgent, 'rules'), 'workspace', '.agent-us/rules');
  mcpServers.push(
    ...readNativeMcpFile(join(wsDotAgent, 'mcp.json'), {
      scope: 'workspace',
      source: '.agent-us/mcp.json',
      hookTrust,
      enforceTrust: true,
    }),
  );

  return {
    workspaceRoot: ws,
    commands: [...commandMap.values()],
    agents: [...agentMap.values()],
    skills: [...skillMap.values()],
    rules,
    mcpServers,
  };
}

/**
 * Expands `/<native-cmd> <args>` templates using ONLY Agent_US native commands/skills.
 */
export function expandNativeSlashCommand(
  workspaceRoot,
  rawInput,
  { dataRoot = null } = {},
) {
  const input = String(rawInput ?? '').trim();
  const match = /^\/([A-Za-z0-9_.:-]+(?:\/[A-Za-z0-9_.:-]+)*)(?:\s+([\s\S]*))?$/.exec(input);
  if (!match) {
    return { matched: false, expandedText: input, commandMeta: null };
  }
  const cmdName = match[1];
  const argStr = String(match[2] ?? '').trim();
  if (BUILTIN_SLASH_COMMANDS.has(cmdName.toLowerCase())) {
    return { matched: false, expandedText: input, commandMeta: null };
  }

  const native = discoverNativeCustomizations(workspaceRoot, { dataRoot });
  const normalizedTarget = cmdName.replace(/\//g, ':').toLowerCase();
  const cmd =
    native.commands.find(
      (c) =>
        c.name === cmdName ||
        c.aliases?.includes(cmdName) ||
        c.name.toLowerCase() === normalizedTarget ||
        c.aliases?.some((a) => a.toLowerCase() === normalizedTarget),
    ) ?? null;
  const skill = !cmd
    ? native.skills.find(
        (s) => s.name === cmdName || s.name.toLowerCase() === cmdName.toLowerCase(),
      ) ?? null
    : null;
  const target = cmd ?? skill;
  if (!target || !target.path || !existsSync(target.path)) {
    return { matched: false, expandedText: input, commandMeta: null };
  }

  let body;
  try {
    body = stripFrontmatter(readFileSync(target.path, 'utf8')).trim();
  } catch {
    return { matched: false, expandedText: input, commandMeta: null };
  }

  if (/\$ARGUMENTS\b|\$\{ARGUMENTS\}/.test(body)) {
    body = body.replace(/\$\{ARGUMENTS\}|\$ARGUMENTS\b/g, argStr);
  } else if (argStr) {
    body = body ? `${body}\n\nArguments: ${argStr}` : argStr;
  }

  const expandedText = body.trim() || input;
  return {
    matched: true,
    expandedText,
    commandMeta: {
      kind: cmd ? 'command' : 'skill',
      name: target.name,
      scope: target.scope,
      args: argStr,
    },
  };
}

/**
 * Pure read-only scan of external `.claude`, `~/.codex`, `.agents/skills`, and `.mcp.json` configs.
 */
export function scanExternalConfigs({ workspaceRoot, homeDir = null } = {}) {
  const resolvedHome = resolve(
    String(homeDir || process.env.AGENT_US_TEST_HOMEDIR || homedir()),
  );
  const resolvedWs = resolve(String(workspaceRoot || process.cwd()));
  const rawItems = [];
  const seenIds = new Set();

  const pushItem = (item) => {
    if (!item || !item.id || seenIds.has(item.id)) return;
    seenIds.add(item.id);
    rawItems.push(item);
  };

  const scanMarkdownRule = ({
    id,
    provider,
    scope,
    name,
    displayPath,
    filePath,
    targetFilename,
  }) => {
    if (!existsSync(filePath)) return;
    try {
      const st = statSync(filePath);
      if (!st.isFile() || st.size === 0) return;
      const raw = readFileSync(filePath, 'utf8');
      if (!raw.trim()) return;
      pushItem({
        id,
        provider,
        scope,
        kind: 'rule',
        name,
        displayPath,
        summary: summarizeMarkdownText(raw),
        bytes: Buffer.byteLength(raw, 'utf8'),
        _content: raw,
        _targetFilename: targetFilename,
      });
    } catch {
      // ignore unreadable rule file
    }
  };

  const scanCommandsDir = ({ provider, scope, dir, displayPrefix }) => {
    for (const { full, rel } of walkMarkdownFiles(dir)) {
      try {
        const raw = readFileSync(full, 'utf8');
        if (!raw.trim()) continue;
        const stem = rel.replace(/\.md$/i, '');
        const cmdName = parseFrontmatterField(raw, 'name') || stem.replace(/\//g, ':');
        pushItem({
          id: `${provider}:${scope}:command:${stem}`,
          provider,
          scope,
          kind: 'command',
          name: cmdName,
          displayPath: `${displayPrefix}/${rel}`,
          summary:
            redactSecrets(parseFrontmatterField(raw, 'description')) ||
            summarizeMarkdownText(raw),
          bytes: Buffer.byteLength(raw, 'utf8'),
          _content: raw,
          _relPath: sanitizeImportedRelPath(rel),
        });
      } catch {
        // ignore unreadable command
      }
    }
  };

  const scanAgentsDir = ({ provider, scope, dir, displayPrefix }) => {
    if (!existsSync(dir)) return;
    try {
      for (const ent of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
        a.name.localeCompare(b.name),
      )) {
        if (!ent.isFile() || !ent.name.toLowerCase().endsWith('.md')) continue;
        const full = join(dir, ent.name);
        const raw = readFileSync(full, 'utf8');
        if (!raw.trim()) continue;
        const name = parseFrontmatterField(raw, 'name') || ent.name.replace(/\.md$/i, '');
        pushItem({
          id: `${provider}:${scope}:agent:${ent.name}`,
          provider,
          scope,
          kind: 'agent',
          name,
          displayPath: `${displayPrefix}/${ent.name}`,
          summary:
            redactSecrets(parseFrontmatterField(raw, 'description')) ||
            summarizeMarkdownText(raw),
          bytes: Buffer.byteLength(raw, 'utf8'),
          _content: raw,
          _targetFilename: `${safeSlug(ent.name, 'agent')}.md`,
        });
      }
    } catch {
      // ignore unreadable agents dir
    }
  };

  const scanSkillsDir = ({ provider, scope, dir, displayPrefix }) => {
    if (!existsSync(dir)) return;
    try {
      for (const ent of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
        a.name.localeCompare(b.name),
      )) {
        if (!ent.isDirectory()) continue;
        const full = join(dir, ent.name, 'SKILL.md');
        if (!existsSync(full)) continue;
        const raw = readFileSync(full, 'utf8');
        if (!raw.trim()) continue;
        const name = parseFrontmatterField(raw, 'name') || ent.name;
        pushItem({
          id: `${provider}:${scope}:skill:${ent.name}`,
          provider,
          scope,
          kind: 'skill',
          name,
          displayPath: `${displayPrefix}/${ent.name}/SKILL.md`,
          summary:
            redactSecrets(parseFrontmatterField(raw, 'description')) ||
            summarizeMarkdownText(raw),
          bytes: Buffer.byteLength(raw, 'utf8'),
          _content: raw,
          _skillDirName: safeSlug(ent.name, 'skill'),
        });
      }
    } catch {
      // ignore unreadable skills dir
    }
  };

  const scanJsonMcpFile = ({ provider, scope, filePath, displayPrefix }) => {
    if (!existsSync(filePath)) return;
    try {
      const raw = readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      const map = parsed?.mcpServers ?? parsed?.mcp_servers ?? null;
      if (!map || typeof map !== 'object' || Array.isArray(map)) return;
      for (const [serverName, cfg] of Object.entries(map)) {
        if (!cfg || typeof cfg !== 'object') continue;
        const sanitized = sanitizeMcpEntryForStorage(cfg, {
          sourceLabel: `${provider}:${scope}`,
        });
        if (!sanitized) continue;
        pushItem({
          id: `${provider}:${scope}:mcp:${serverName}`,
          provider,
          scope,
          kind: 'mcp',
          name: serverName,
          displayPath: `${displayPrefix}#mcpServers.${serverName}`,
          summary: formatRedactedMcpSummary(serverName, cfg),
          bytes: Buffer.byteLength(JSON.stringify(cfg), 'utf8'),
          _mcpServerName: serverName,
          _mcpSpec: sanitized,
        });
      }
    } catch {
      // ignore malformed MCP JSON
    }
  };

  // 1. User home scan (~/.claude & ~/.codex)
  const userClaudeDir = join(resolvedHome, '.claude');
  scanMarkdownRule({
    id: 'claude:user:rule:CLAUDE.md',
    provider: 'claude',
    scope: 'user',
    name: 'CLAUDE.md',
    displayPath: '~/.claude/CLAUDE.md',
    filePath: join(userClaudeDir, 'CLAUDE.md'),
    targetFilename: 'claude-user.md',
  });
  for (const { full, rel } of walkMarkdownFiles(join(userClaudeDir, 'rules'))) {
    scanMarkdownRule({
      id: `claude:user:rule:${rel}`,
      provider: 'claude',
      scope: 'user',
      name: rel.replace(/\.md$/i, ''),
      displayPath: `~/.claude/rules/${rel}`,
      filePath: full,
      targetFilename: `claude-user-${safeSlug(rel.replace(/\//g, '-'))}.md`,
    });
  }
  scanCommandsDir({
    provider: 'claude',
    scope: 'user',
    dir: join(userClaudeDir, 'commands'),
    displayPrefix: '~/.claude/commands',
  });
  scanAgentsDir({
    provider: 'claude',
    scope: 'user',
    dir: join(userClaudeDir, 'agents'),
    displayPrefix: '~/.claude/agents',
  });
  scanSkillsDir({
    provider: 'claude',
    scope: 'user',
    dir: join(userClaudeDir, 'skills'),
    displayPrefix: '~/.claude/skills',
  });
  scanJsonMcpFile({
    provider: 'claude',
    scope: 'user',
    filePath: join(resolvedHome, '.claude.json'),
    displayPrefix: '~/.claude.json',
  });

  const userCodexDir = join(resolvedHome, '.codex');
  scanMarkdownRule({
    id: 'codex:user:rule:AGENTS.md',
    provider: 'codex',
    scope: 'user',
    name: 'AGENTS.md',
    displayPath: '~/.codex/AGENTS.md',
    filePath: join(userCodexDir, 'AGENTS.md'),
    targetFilename: 'codex-agents.md',
  });
  scanMarkdownRule({
    id: 'codex:user:rule:instructions.md',
    provider: 'codex',
    scope: 'user',
    name: 'instructions.md',
    displayPath: '~/.codex/instructions.md',
    filePath: join(userCodexDir, 'instructions.md'),
    targetFilename: 'codex-instructions.md',
  });
  scanSkillsDir({
    provider: 'codex',
    scope: 'user',
    dir: join(userCodexDir, 'skills'),
    displayPrefix: '~/.codex/skills',
  });
  const codexTomlPath = join(userCodexDir, 'config.toml');
  if (existsSync(codexTomlPath)) {
    try {
      const rawToml = readFileSync(codexTomlPath, 'utf8');
      const { servers, instructions } = parseCodexTomlConfig(rawToml);
      if (instructions.trim()) {
        pushItem({
          id: 'codex:user:rule:config.toml',
          provider: 'codex',
          scope: 'user',
          kind: 'rule',
          name: 'codex-config-instructions',
          displayPath: '~/.codex/config.toml#instructions',
          summary: summarizeMarkdownText(instructions),
          bytes: Buffer.byteLength(instructions, 'utf8'),
          _content: redactSecrets(instructions),
          _targetFilename: 'codex-config-instructions.md',
        });
      }
      for (const [serverName, cfg] of Object.entries(servers)) {
        const sanitized = sanitizeMcpEntryForStorage(cfg, {
          sourceLabel: 'codex:user',
        });
        if (!sanitized) continue;
        pushItem({
          id: `codex:user:mcp:${serverName}`,
          provider: 'codex',
          scope: 'user',
          kind: 'mcp',
          name: serverName,
          displayPath: `~/.codex/config.toml#mcp_servers.${serverName}`,
          summary: formatRedactedMcpSummary(serverName, cfg),
          bytes: Buffer.byteLength(JSON.stringify(cfg), 'utf8'),
          _mcpServerName: serverName,
          _mcpSpec: sanitized,
        });
      }
    } catch {
      // ignore malformed config.toml
    }
  }
  const codexJsonPath = join(userCodexDir, 'config.json');
  if (existsSync(codexJsonPath)) {
    scanJsonMcpFile({
      provider: 'codex',
      scope: 'user',
      filePath: codexJsonPath,
      displayPrefix: '~/.codex/config.json',
    });
    try {
      const parsed = JSON.parse(readFileSync(codexJsonPath, 'utf8'));
      const instr = parsed?.developer_instructions || parsed?.instructions;
      if (typeof instr === 'string' && instr.trim()) {
        pushItem({
          id: 'codex:user:rule:config.json',
          provider: 'codex',
          scope: 'user',
          kind: 'rule',
          name: 'codex-json-instructions',
          displayPath: '~/.codex/config.json#instructions',
          summary: summarizeMarkdownText(instr),
          bytes: Buffer.byteLength(instr, 'utf8'),
          _content: redactSecrets(instr),
          _targetFilename: 'codex-json-instructions.md',
        });
      }
    } catch {
      // ignore malformed config.json
    }
  }

  // 2. Workspace scan (CLAUDE.md, .claude/**, .agents/skills/*/SKILL.md, .mcp.json)
  scanMarkdownRule({
    id: 'claude:workspace:rule:CLAUDE.md',
    provider: 'claude',
    scope: 'workspace',
    name: 'CLAUDE.md',
    displayPath: 'CLAUDE.md',
    filePath: join(resolvedWs, 'CLAUDE.md'),
    targetFilename: 'claude-project.md',
  });
  const wsClaudeDir = join(resolvedWs, '.claude');
  scanMarkdownRule({
    id: 'claude:workspace:rule:.claude/CLAUDE.md',
    provider: 'claude',
    scope: 'workspace',
    name: 'claude-project-instructions',
    displayPath: '.claude/CLAUDE.md',
    filePath: join(wsClaudeDir, 'CLAUDE.md'),
    targetFilename: 'claude-dotclaude.md',
  });
  for (const { full, rel } of walkMarkdownFiles(join(wsClaudeDir, 'rules'))) {
    scanMarkdownRule({
      id: `claude:workspace:rule:${rel}`,
      provider: 'claude',
      scope: 'workspace',
      name: rel.replace(/\.md$/i, ''),
      displayPath: `.claude/rules/${rel}`,
      filePath: full,
      targetFilename: `claude-${safeSlug(rel.replace(/\//g, '-'))}.md`,
    });
  }
  scanCommandsDir({
    provider: 'claude',
    scope: 'workspace',
    dir: join(wsClaudeDir, 'commands'),
    displayPrefix: '.claude/commands',
  });
  scanAgentsDir({
    provider: 'claude',
    scope: 'workspace',
    dir: join(wsClaudeDir, 'agents'),
    displayPrefix: '.claude/agents',
  });
  scanSkillsDir({
    provider: 'claude',
    scope: 'workspace',
    dir: join(wsClaudeDir, 'skills'),
    displayPrefix: '.claude/skills',
  });
  scanJsonMcpFile({
    provider: 'claude',
    scope: 'workspace',
    filePath: join(wsClaudeDir, 'settings.json'),
    displayPrefix: '.claude/settings.json',
  });
  scanSkillsDir({
    provider: 'agents',
    scope: 'workspace',
    dir: join(resolvedWs, '.agents', 'skills'),
    displayPrefix: '.agents/skills',
  });
  scanJsonMcpFile({
    provider: 'claude',
    scope: 'workspace',
    filePath: join(resolvedWs, '.mcp.json'),
    displayPrefix: '.mcp.json',
  });

  const publicItems = rawItems.map(
    ({ id, provider, scope, kind, name, displayPath, summary, bytes }) => ({
      id,
      provider,
      scope,
      kind,
      name,
      displayPath,
      summary,
      bytes,
    }),
  );
  const counts = {
    rules: publicItems.filter((i) => i.kind === 'rule').length,
    commands: publicItems.filter((i) => i.kind === 'command').length,
    skills: publicItems.filter((i) => i.kind === 'skill').length,
    agents: publicItems.filter((i) => i.kind === 'agent').length,
    mcp: publicItems.filter((i) => i.kind === 'mcp').length,
    total: publicItems.length,
  };
  const providers = [...new Set(publicItems.map((i) => i.provider))];

  return {
    homeDir: resolvedHome,
    workspaceRoot: resolvedWs,
    rawItems,
    publicItems,
    counts,
    providers,
  };
}

/**
 * Copies & converts selected external items into Agent_US native format without mutating
 * any source `~/.claude`, `~/.codex`, `.claude`, `.agents`, or `.mcp.json` file.
 */
export function importExternalConfigItems({
  workspaceRoot,
  dataRoot = null,
  rawItems = [],
  targetScope = 'auto',
} = {}) {
  const ws = resolve(String(workspaceRoot || process.cwd()));
  const data = dataRoot ? resolve(String(dataRoot)) : null;
  const importedItems = [];

  const mergeMcpFile = (filePath, entries) => {
    let existing = { mcpServers: {} };
    if (existsSync(filePath)) {
      try {
        const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          existing = {
            ...parsed,
            mcpServers:
              parsed.mcpServers && typeof parsed.mcpServers === 'object'
                ? { ...parsed.mcpServers }
                : {},
          };
        }
      } catch {
        existing = { mcpServers: {} };
      }
    }
    for (const [serverName, spec] of entries) {
      existing.mcpServers[serverName] = spec;
    }
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(existing, null, 2) + '\n', 'utf8');
  };

  const pendingUserMcp = [];
  const pendingWsMcp = [];

  for (const item of rawItems) {
    const destScope =
      targetScope === 'user'
        ? data
          ? 'user'
          : 'workspace'
        : targetScope === 'workspace'
          ? 'workspace'
          : item.scope === 'user' && data
            ? 'user'
            : 'workspace';
    const destRoot = destScope === 'user' ? data : join(ws, '.agent-us');

    if (item.kind === 'rule') {
      const targetPath = join(
        destRoot,
        'rules',
        item._targetFilename || `${safeSlug(item.name, 'rule')}.md`,
      );
      mkdirSync(dirname(targetPath), { recursive: true });
      writeFileSync(targetPath, redactSecrets(String(item._content ?? '')), 'utf8');
      importedItems.push({
        id: item.id,
        provider: item.provider,
        sourceScope: item.scope,
        targetScope: destScope,
        kind: item.kind,
        name: item.name,
        displayPath: item.displayPath,
        targetPath,
      });
    } else if (item.kind === 'command') {
      const relPath = item._relPath || `${safeSlug(item.name, 'command')}.md`;
      const targetPath = join(destRoot, 'commands', relPath);
      mkdirSync(dirname(targetPath), { recursive: true });
      writeFileSync(targetPath, String(item._content ?? ''), 'utf8');
      importedItems.push({
        id: item.id,
        provider: item.provider,
        sourceScope: item.scope,
        targetScope: destScope,
        kind: item.kind,
        name: item.name,
        displayPath: item.displayPath,
        targetPath,
      });
    } else if (item.kind === 'agent') {
      const targetPath = join(
        destRoot,
        'agents',
        item._targetFilename || `${safeSlug(item.name, 'agent')}.md`,
      );
      mkdirSync(dirname(targetPath), { recursive: true });
      writeFileSync(targetPath, String(item._content ?? ''), 'utf8');
      importedItems.push({
        id: item.id,
        provider: item.provider,
        sourceScope: item.scope,
        targetScope: destScope,
        kind: item.kind,
        name: item.name,
        displayPath: item.displayPath,
        targetPath,
      });
    } else if (item.kind === 'skill') {
      const skillDir = item._skillDirName || safeSlug(item.name, 'skill');
      const targetPath = join(destRoot, 'skills', skillDir, 'SKILL.md');
      mkdirSync(dirname(targetPath), { recursive: true });
      writeFileSync(targetPath, String(item._content ?? ''), 'utf8');
      importedItems.push({
        id: item.id,
        provider: item.provider,
        sourceScope: item.scope,
        targetScope: destScope,
        kind: item.kind,
        name: item.name,
        displayPath: item.displayPath,
        targetPath,
      });
    } else if (item.kind === 'mcp' && item._mcpServerName && item._mcpSpec) {
      const targetPath =
        destScope === 'user'
          ? join(destRoot, 'mcp-imported.json')
          : join(destRoot, 'mcp.json');
      if (destScope === 'user') {
        pendingUserMcp.push([item._mcpServerName, item._mcpSpec]);
      } else {
        pendingWsMcp.push([item._mcpServerName, item._mcpSpec]);
      }
      importedItems.push({
        id: item.id,
        provider: item.provider,
        sourceScope: item.scope,
        targetScope: destScope,
        kind: item.kind,
        name: item.name,
        displayPath: item.displayPath,
        targetPath,
      });
    }
  }

  if (pendingUserMcp.length > 0 && data) {
    mergeMcpFile(join(data, 'mcp-imported.json'), pendingUserMcp);
  }
  if (pendingWsMcp.length > 0) {
    mergeMcpFile(join(ws, '.agent-us', 'mcp.json'), pendingWsMcp);
  }

  return importedItems;
}
