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
class McpResponseError extends Error {}

const MAX_DISCOVERY_CONCURRENCY = 4;
const MAX_TOOL_PAGES = 16;
const MAX_SERVER_TOOLS = 2048;

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
        if (this.proc !== child) return;
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
              if (msg.error) p.reject(new McpResponseError(msg.error.message || 'MCP error'));
              else p.resolve(msg.result);
            }
          } catch {
            // ignore non-JSON log lines
          }
        }
      });
      child.on('error', (err) => {
        if (this.proc !== child) return;
        this.initialized = false;
        this.proc = null;
        this.#rejectAllPending(new Error(`MCP server ${this.name} spawn error: ${err?.message ?? err}`));
      });
      child.on('exit', () => {
        if (this.proc !== child) return;
        this.initialized = false;
        this.proc = null;
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

  request(method, params, timeoutMs = 10000, signal = null) {
    return new Promise((resolveReq, rejectReq) => {
      signal?.throwIfAborted();
      if (!this.proc || this.proc.killed || !this.proc.stdin || this.proc.stdin.destroyed) {
        rejectReq(new Error(`MCP server ${this.name} is not running`));
        return;
      }
      const id = this.nextId++;
      const timer = setTimeout(() => {
        fail(new Error(`MCP request ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      const cleanup = () => {
        this.pending.delete(id);
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      const fail = (err) => {
        cleanup();
        rejectReq(err);
      };
      const onAbort = () => fail(signal.reason);
      signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, {
        resolve: (val) => {
          cleanup();
          resolveReq(val);
        },
        reject: fail,
      });
      try {
        this.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      } catch (err) {
        fail(err);
      }
    });
  }

  async listTools() {
    await this.connect();
    const deadline = Date.now() + 6000;
    const tools = [];
    const seen = new Set();
    let cursor;
    for (let page = 0; page < MAX_TOOL_PAGES; page++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('MCP tools/list deadline exceeded');
      const res = await this.request('tools/list', cursor === undefined ? {} : { cursor }, remaining);
      if (!Array.isArray(res?.tools)) throw new Error('Invalid MCP tool catalog');
      if (tools.length + res.tools.length > MAX_SERVER_TOOLS) {
        throw new Error('MCP tool catalog exceeds the tool limit');
      }
      for (const tool of res.tools) {
        if (typeof tool?.name !== 'string' || !tool.name.trim()) throw new Error('Invalid MCP tool name');
        tools.push(tool);
      }
      cursor = res.nextCursor;
      if (cursor === undefined) return tools;
      if (typeof cursor !== 'string' || seen.has(cursor)) {
        throw new Error('MCP tools/list returned an invalid or repeated cursor');
      }
      seen.add(cursor);
    }
    throw new Error('MCP tools/list exceeded the page limit');
  }

  async callTool(toolName, args, { signal = null } = {}) {
    await this.connect();
    signal?.throwIfAborted();
    let res;
    try {
      res = await this.request('tools/call', { name: toolName, arguments: args ?? {} }, 20000, signal);
    } catch (err) {
      // An explicit protocol error is a response. A lost response is not evidence
      // that the remote effect did not happen; never retry it automatically.
      if (err instanceof McpResponseError) return { isError: true, text: err.message };
      return { outcomeUnknown: true, text: 'MCP tools/call 未收到可确认的响应。' };
    }
    if (!res || typeof res !== 'object' ||
        (!Array.isArray(res.content) && (!res.structuredContent || typeof res.structuredContent !== 'object')) ||
        (res.isError !== undefined && typeof res.isError !== 'boolean')) {
      return { outcomeUnknown: true, text: 'MCP tools/call 返回了无效的响应。' };
    }
    const text = Array.isArray(res.content)
      ? res.content.map((c) => (c?.type === 'text' ? c.text : JSON.stringify(c))).join('\n')
      : '';
    return { text: text || JSON.stringify(res.structuredContent ?? {}), isError: res.isError === true };
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
    this.closed = false;
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
    const entries = Object.entries(specs).filter(([name]) =>
      !(includeServers instanceof Set) || includeServers.has(name),
    );
    const results = new Array(entries.length);
    let next = 0;
    const work = async () => {
      while (!this.closed && next < entries.length) {
        const index = next++;
        const [serverName, argv] = entries[index];
        const key = `${resolve(workspaceRoot)}::${serverName}`;
        let conn = this.conns.get(key);
        if (!conn) {
          conn = new StdioMcpConnection(serverName, argv, resolve(workspaceRoot));
          this.conns.set(key, conn);
        }
        try {
          const remote = await conn.listTools();
          results[index] = { serverName, tools: remote.map((t) => ({
            fullName: `mcp__${serverName.replace(/[^a-zA-Z0-9_-]/g, '_')}__${t.name.replace(/[^a-zA-Z0-9_-]/g, '_')}`,
            serverName,
            toolName: t.name,
            description: `[MCP:${serverName}] ${t.description || t.name}`,
            parameters: t.inputSchema ?? { type: 'object', properties: {} },
            call: (args, opts) => {
              if (this.closed) throw new Error('MCP hub is closed');
              return conn.callTool(t.name, args, opts);
            },
          })) };
        } catch (err) {
          results[index] = { serverName, tools: [], error: String(err?.message ?? err) };
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(MAX_DISCOVERY_CONCURRENCY, entries.length) }, work));
    if (this.closed) return [];
    const counts = new Map();
    for (const { tools } of results) {
      for (const t of tools) counts.set(t.fullName, (counts.get(t.fullName) ?? 0) + 1);
    }
    return results.flatMap(({ serverName, tools, error }) => {
      // A normalized alias must not silently bind to a different server/tool.
      const unique = tools.filter((t) => counts.get(t.fullName) === 1);
      const collision = unique.length !== tools.length;
      onServerResult?.(serverName, {
        ok: !error && (!collision || unique.length > 0),
        toolCount: unique.length,
        error: error ?? (collision ? 'Ambiguous MCP tool aliases omitted' : null),
      });
      return unique;
    });
  }

  close() {
    this.closed = true;
    for (const c of this.conns.values()) c.close();
    this.conns.clear();
  }
}
