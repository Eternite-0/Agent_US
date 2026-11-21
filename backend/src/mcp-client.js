import { spawn } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { killProcessTree, sanitizeChildEnv } from './tools/sandbox.js';
import { HookTrustManager } from './tools/hook-trust.js';

/**
 * Lightweight stdio JSON-RPC 2.0 MCP client for Direct Agent.
 * Discovers configured servers from operator `staticMcp`, `<dataRoot>/mcp.json`, or explicitly
 * SHA-256 trusted `<workspaceRoot>/.agent-us/mcp.json`, enumerates tools via `initialize` + `tools/list`,
 * and dispatches `tools/call` with sanitized child environment and process-tree cleanup.
 */
class StdioMcpConnection {
  constructor(name, argv, cwd) {
    this.name = name;
    this.argv = argv;
    this.cwd = cwd;
    this.proc = null;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = '';
    this.initialized = false;
    this.connectPromise = null;
  }

  #rejectAllPending(reason) {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    for (const p of [...this.pending.values()]) {
      p.reject(err);
    }
    this.pending.clear();
  }

  async connect(timeoutMs = 6000) {
    if (this.proc && !this.proc.killed && this.initialized) return;
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = (async () => {
      const [cmd, ...args] = this.argv;
      const isWin = process.platform === 'win32';
      const child = spawn(cmd, args, {
        cwd: this.cwd,
        windowsHide: true,
        detached: !isWin,
        env: sanitizeChildEnv(process.env),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.proc = child;
      this.buffer = '';

      child.stdin?.on('error', () => {
        // isolate broken-pipe errors when server exits early
      });
      child.stdout?.on('data', (chunk) => {
        this.buffer += chunk.toString('utf8');
        const lines = this.buffer.split(/\r?\n/);
        this.buffer = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const msg = JSON.parse(trimmed);
            if (msg.id !== undefined && this.pending.has(msg.id)) {
              const p = this.pending.get(msg.id);
              this.pending.delete(msg.id);
              if (msg.error) p.reject(new Error(msg.error.message || 'MCP error'));
              else p.resolve(msg.result);
            }
          } catch {
            // ignore non-JSON log lines
          }
        }
      });
      child.on('error', (err) => {
        this.initialized = false;
        if (this.proc === child) this.proc = null;
        this.#rejectAllPending(new Error(`MCP server ${this.name} spawn error: ${err?.message ?? err}`));
      });
      child.on('exit', () => {
        this.initialized = false;
        if (this.proc === child) this.proc = null;
        this.#rejectAllPending(new Error(`MCP server ${this.name} exited`));
      });

      try {
        await this.request(
          'initialize',
          {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'agent-us', version: '0.2.0' },
          },
          timeoutMs,
        );
        this.notify('notifications/initialized', {});
        this.initialized = true;
      } catch (err) {
        this.close();
        throw err;
      }
    })();

    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  notify(method, params) {
    if (!this.proc || this.proc.killed || !this.proc.stdin || this.proc.stdin.destroyed) return;
    try {
      this.proc.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`,
      );
    } catch {
      // ignore broken pipe
    }
  }

  request(method, params, timeoutMs = 10000) {
    return new Promise((resolveReq, rejectReq) => {
      if (!this.proc || this.proc.killed || !this.proc.stdin || this.proc.stdin.destroyed) {
        rejectReq(new Error(`MCP server ${this.name} is not running`));
        return;
      }
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectReq(new Error(`MCP request ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, {
        resolve: (val) => {
          clearTimeout(timer);
          resolveReq(val);
        },
        reject: (err) => {
          clearTimeout(timer);
          rejectReq(err);
        },
      });
      try {
        this.proc.stdin.write(
          `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`,
        );
      } catch (err) {
        const entry = this.pending.get(id);
        this.pending.delete(id);
        entry?.reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  async listTools() {
    await this.connect();
    const res = await this.request('tools/list', {});
    return Array.isArray(res?.tools) ? res.tools : [];
  }

  async callTool(toolName, args, timeoutMs = 20000) {
    await this.connect();
    const res = await this.request(
      'tools/call',
      { name: toolName, arguments: args ?? {} },
      timeoutMs,
    );
    if (Array.isArray(res?.content)) {
      return res.content
        .map((c) => (c.type === 'text' ? c.text : JSON.stringify(c)))
        .join('\n');
    }
    return JSON.stringify(res ?? {});
  }

  close() {
    const child = this.proc;
    this.proc = null;
    this.initialized = false;
    this.#rejectAllPending(new Error(`MCP server ${this.name} closed`));
    if (child && !child.killed) {
      killProcessTree(child);
    }
  }
}

function parseMcpSpecsBuffer(buf, targetSpecs) {
  const parsed = JSON.parse(buf.toString('utf8'));
  const map = parsed?.mcpServers ?? parsed?.servers ?? parsed ?? {};
  for (const [name, cfg] of Object.entries(map)) {
    if (Array.isArray(cfg) && cfg.length) {
      targetSpecs[name] = cfg;
    } else if (cfg && typeof cfg.command === 'string') {
      targetSpecs[name] = [cfg.command, ...(Array.isArray(cfg.args) ? cfg.args : [])];
    }
  }
}

export function loadMcpServerSpecs(
  workspaceRoot,
  {
    dataRoot = null,
    staticMcp = {},
    trustManager = null,
    store = null,
    trustWorkspaceMcp = false,
    onUntrusted = null,
  } = {},
) {
  const specs = {};
  for (const [k, v] of Object.entries(staticMcp ?? {})) {
    if (Array.isArray(v) && v.length) specs[k] = v;
  }

  // Operator-controlled dataRoot mcp.json
  if (dataRoot) {
    const dataFile = join(resolve(dataRoot), 'mcp.json');
    if (existsSync(dataFile)) {
      try {
        parseMcpSpecsBuffer(readFileSync(dataFile), specs);
      } catch {
        // skip malformed mcp.json
      }
    }
  }

  // Workspace-controlled .agent-us/mcp.json MUST pass explicit SHA-256 trust boundary (fail-closed)
  const wsMcpFile = join(resolve(workspaceRoot), '.agent-us', 'mcp.json');
  if (existsSync(wsMcpFile)) {
    let readTarget = wsMcpFile;
    try {
      readTarget = realpathSync(wsMcpFile);
    } catch {
      readTarget = wsMcpFile;
    }
    let rawBuffer;
    try {
      rawBuffer = readFileSync(readTarget);
    } catch {
      return specs;
    }

    if (!trustWorkspaceMcp) {
      const effectiveTrust =
        trustManager ?? (store ? new HookTrustManager({ store }) : null);
      if (!effectiveTrust) {
        onUntrusted?.({
          filePath: wsMcpFile,
          reason: 'MCP_CONFIG_UNTRUSTED_NO_TRUST_MANAGER',
        });
        return specs;
      }
      const trust = effectiveTrust.verifyFile(wsMcpFile, { rawBuffer });
      if (!trust.trusted) {
        onUntrusted?.({
          filePath: wsMcpFile,
          configPath: trust.configPath,
          contentDigest: trust.contentDigest,
          reason: trust.reason,
        });
        return specs;
      }
    }

    try {
      parseMcpSpecsBuffer(rawBuffer, specs);
    } catch {
      // skip malformed mcp.json
    }
  }

  return specs;
}

export class McpHub {
  constructor({
    dataRoot = null,
    staticMcp = {},
    trustManager = null,
    store = null,
    trustWorkspaceMcp = false,
  } = {}) {
    this.dataRoot = dataRoot;
    this.staticMcp = staticMcp;
    this.trustManager = trustManager ?? (store ? new HookTrustManager({ store }) : null);
    this.store = store;
    this.trustWorkspaceMcp = Boolean(trustWorkspaceMcp);
    this.conns = new Map(); // `${workspaceRoot}::${serverName}` -> StdioMcpConnection
  }

  async discoverTools(
    workspaceRoot,
    {
      includeServers = null,
      trustManager = null,
      trustWorkspaceMcp = null,
      onServerResult = null,
      onUntrusted = null,
    } = {},
  ) {
    const specs = loadMcpServerSpecs(workspaceRoot, {
      dataRoot: this.dataRoot,
      staticMcp: this.staticMcp,
      trustManager: trustManager ?? this.trustManager,
      store: this.store,
      trustWorkspaceMcp:
        trustWorkspaceMcp !== null ? Boolean(trustWorkspaceMcp) : this.trustWorkspaceMcp,
      onUntrusted,
    });
    const tools = [];
    for (const [serverName, argv] of Object.entries(specs)) {
      if (includeServers instanceof Set && !includeServers.has(serverName)) {
        continue;
      }
      const key = `${resolve(workspaceRoot)}::${serverName}`;
      let conn = this.conns.get(key);
      if (!conn) {
        conn = new StdioMcpConnection(serverName, argv, resolve(workspaceRoot));
        this.conns.set(key, conn);
      }
      try {
        const remote = await conn.listTools();
        for (const t of remote) {
          const safeServer = serverName.replace(/[^a-zA-Z0-9_-]/g, '_');
          const safeTool = String(t.name).replace(/[^a-zA-Z0-9_-]/g, '_');
          tools.push({
            fullName: `mcp__${safeServer}__${safeTool}`,
            serverName,
            toolName: t.name,
            description: `[MCP:${serverName}] ${t.description || t.name}`,
            parameters: t.inputSchema ?? { type: 'object', properties: {} },
            call: (args) => conn.callTool(t.name, args),
          });
        }
        onServerResult?.(serverName, { ok: true, toolCount: remote.length, error: null });
      } catch (err) {
        onServerResult?.(serverName, {
          ok: false,
          toolCount: 0,
          error: String(err?.message ?? err),
        });
        // Offline MCP server degrades gracefully without crashing the session
      }
    }
    return tools;
  }

  close() {
    for (const c of this.conns.values()) c.close();
    this.conns.clear();
  }
}
