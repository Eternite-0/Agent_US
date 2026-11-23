import { resolve } from 'node:path';
import { McpHub, loadMcpServerSpecs } from '../mcp-client.js';
import { EFFECT_CLASSES, RISK_LEVELS } from './registry.js';

/**
 * Layer 4 MCP Lifecycle Manager tracking server health states, bounded backoff,
 * and wrapping MCP tools as outward external_network tools requiring explicit gating.
 */
export class McpLifecycleManager {
  constructor({
    dataRoot = null,
    staticMcp = {},
    hub = null,
    trustManager = null,
    store = null,
    trustWorkspaceMcp = false,
  } = {}) {
    this.dataRoot = dataRoot;
    this.staticMcp = staticMcp;
    this.trustManager = trustManager ?? null;
    this.store = store ?? null;
    this.trustWorkspaceMcp = Boolean(trustWorkspaceMcp);
    this.hub =
      hub ??
      new McpHub({
        dataRoot,
        staticMcp,
        trustManager: this.trustManager,
        store: this.store,
        trustWorkspaceMcp: this.trustWorkspaceMcp,
      });
    this.closed = false;
    this.health = new Map(); // serverKey -> { server, status, toolCount, lastError, lastCheckedAt, failures }
  }

  async discoverTools(workspaceRoot, { trustManager = null, trustWorkspaceMcp = null } = {}) {
    if (this.closed) return [];
    const ws = resolve(workspaceRoot);
    const effTrust = trustManager ?? this.trustManager ?? this.hub?.trustManager ?? null;
    const effAllowWs =
      trustWorkspaceMcp !== null
        ? Boolean(trustWorkspaceMcp)
        : this.trustWorkspaceMcp || Boolean(this.hub?.trustWorkspaceMcp);

    const specs = loadMcpServerSpecs(ws, {
      dataRoot: this.dataRoot,
      staticMcp: this.staticMcp,
      trustManager: effTrust,
      store: this.store,
      trustWorkspaceMcp: effAllowWs,
    });
    const serverNames = Object.keys(specs);
    if (!serverNames.length) return [];

    const now = Date.now();
    const allowedServers = new Set();
    for (const serverName of serverNames) {
      const key = `${ws}::${serverName}`;
      const prev = this.health.get(key) ?? {
        server: serverName,
        status: 'disconnected',
        toolCount: 0,
        lastError: null,
        lastCheckedAt: 0,
        failures: 0,
      };
      // Bounded backoff for repeatedly failing servers (strictly enforced before connecting!)
      if (
        prev.status === 'degraded' &&
        now - prev.lastCheckedAt < Math.min(30000, prev.failures * 3000)
      ) {
        continue;
      }
      prev.status = 'connecting';
      this.health.set(key, prev);
      allowedServers.add(serverName);
    }

    if (!allowedServers.size) return [];

    const tools = [];
    const resultsByServer = new Map();
    try {
      const discovered = await this.hub.discoverTools(ws, {
        includeServers: allowedServers,
        trustManager: effTrust,
        trustWorkspaceMcp: effAllowWs,
        onServerResult: (serverName, info) => {
          resultsByServer.set(serverName, info);
        },
      });
      if (this.closed) return [];
      for (const mt of discovered) {
        tools.push({
          ...mt,
          meta: {
            readOnly: false,
            effectClass: EFFECT_CLASSES.EXTERNAL_NETWORK,
            riskLevel: RISK_LEVELS.HIGH,
            replayable: false,
            outward: true,
          },
        });
      }
      const checkedAt = Date.now();
      for (const serverName of allowedServers) {
        const key = `${ws}::${serverName}`;
        const prev = this.health.get(key);
        const res = resultsByServer.get(serverName);
        if (res && res.ok) {
          this.health.set(key, {
            server: serverName,
            status: 'ready',
            toolCount: res.toolCount ?? 0,
            lastError: res.error ?? null,
            lastCheckedAt: checkedAt,
            failures: 0,
          });
        } else {
          this.health.set(key, {
            server: serverName,
            status: 'degraded',
            toolCount: 0,
            lastError: res?.error || 'MCP discovery failed',
            lastCheckedAt: checkedAt,
            failures: (prev?.failures ?? 0) + 1,
          });
        }
      }
    } catch (err) {
      if (this.closed) return [];
      const checkedAt = Date.now();
      for (const serverName of allowedServers) {
        const key = `${ws}::${serverName}`;
        const prev = this.health.get(key);
        this.health.set(key, {
          server: serverName,
          status: 'degraded',
          toolCount: 0,
          lastError: String(err?.message ?? err),
          lastCheckedAt: checkedAt,
          failures: (prev?.failures ?? 0) + 1,
        });
      }
    }
    return tools;
  }

  getStatus(workspaceRoot) {
    if (workspaceRoot) {
      const workspacePrefix = `${resolve(workspaceRoot)}::`;
      return [...this.health.entries()]
        .filter(([key, record]) => key === `${workspacePrefix}${record.server}`)
        .map(([, record]) => record);
    }
    return [...this.health.values()];
  }

  close() {
    this.closed = true;
    for (const h of this.health.values()) {
      h.status = 'closed';
    }
    this.hub.close();
  }
}
