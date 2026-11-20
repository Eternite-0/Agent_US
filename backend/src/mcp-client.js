import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Lightweight stdio JSON-RPC 2.0 MCP client for Direct Agent.
 * Discovers configured servers from `.agent-us/mcp.json` or `config.json` (`mcp`),
 * enumerates tools via `initialize` + `tools/list`, and dispatches `tools/call`.
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
  }

  async connect(timeoutMs = 6000) {
    if (this.proc && !this.proc.killed && this.initialized) return;
    const [cmd, ...args] = this.argv;
    this.proc = spawn(cmd, args, {
      cwd: this.cwd,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc.stdout.on('data', (chunk) => {
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
    this.proc.on('exit', () => {
      for (const p of this.pending.values()) {
        p.reject(new Error(`MCP server ${this.name} exited`));
      }
      this.pending.clear();
      this.initialized = false;
    });
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
  }

  notify(method, params) {
    if (!this.proc || this.proc.killed) return;
    this.proc.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`,
    );
  }

  request(method, params, timeoutMs = 10000) {
    return new Promise((resolveReq, rejectReq) => {
      if (!this.proc || this.proc.killed) {
        rejectReq(new Error(`MCP server ${this.name} is not running`));
        return;
      }
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectReq(new Error(`MCP request ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
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
      this.proc.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`,
      );
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
    if (this.proc && !this.proc.killed) {
      try {
        this.proc.kill('SIGTERM');
      } catch {
        // ignore
      }
    }
    this.proc = null;
    this.initialized = false;
  }
}

export function loadMcpServerSpecs(workspaceRoot, { dataRoot = null, staticMcp = {} } = {}) {
  const specs = {};
  for (const [k, v] of Object.entries(staticMcp ?? {})) {
    if (Array.isArray(v) && v.length) specs[k] = v;
  }
  const files = [
    ...(dataRoot ? [join(resolve(dataRoot), 'mcp.json')] : []),
    join(resolve(workspaceRoot), '.agent-us', 'mcp.json'),
  ];
  for (const f of files) {
    if (!existsSync(f)) continue;
    try {
      const parsed = JSON.parse(readFileSync(f, 'utf8'));
      const map = parsed?.mcpServers ?? parsed?.servers ?? parsed ?? {};
      for (const [name, cfg] of Object.entries(map)) {
        if (Array.isArray(cfg) && cfg.length) {
          specs[name] = cfg;
        } else if (cfg && typeof cfg.command === 'string') {
          specs[name] = [cfg.command, ...(Array.isArray(cfg.args) ? cfg.args : [])];
        }
      }
    } catch {
      // skip malformed mcp.json
    }
  }
  return specs;
}

export class McpHub {
  constructor({ dataRoot = null, staticMcp = {} } = {}) {
    this.dataRoot = dataRoot;
    this.staticMcp = staticMcp;
    this.conns = new Map(); // `${workspaceRoot}::${serverName}` -> StdioMcpConnection
  }

  async discoverTools(workspaceRoot) {
    const specs = loadMcpServerSpecs(workspaceRoot, {
      dataRoot: this.dataRoot,
      staticMcp: this.staticMcp,
    });
    const tools = [];
    for (const [serverName, argv] of Object.entries(specs)) {
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
      } catch {
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
