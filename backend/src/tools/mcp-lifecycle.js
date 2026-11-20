import { resolve } from 'node:path';
import { McpHub, loadMcpServerSpecs } from '../mcp-client.js';
import { EFFECT_CLASSES, RISK_LEVELS } from './registry.js';

/**
 * Layer 4 MCP Lifecycle Manager tracking server health states, bounded backoff,
 * and wrapping MCP tools as outward external_network tools requiring explicit gating.
 */
export class McpLifecycleManager {
  constructor({ dataRoot = null, staticMcp = {}, hub = null } = {}) {
    this.dataRoot = dataRoot;
    this.staticMcp = staticMcp;
    this.hub = hub ?? new McpHub({ dataRoot, staticMcp });
    this.health = new Map(); // serverKey -> { server, status, toolCount, lastError, lastCheckedAt, failures }
  }

  async discoverTools(workspaceRoot) {
    const ws = resolve(workspaceRoot);
    const specs = loadMcpServerSpecs(ws, {
      dataRoot: this.dataRoot,
      staticMcp: this.staticMcp,
    });
    const tools = [];
    for (const serverName of Object.keys(specs)) {
      const key = `${ws}::${serverName}`;
      const prev = this.health.get(key) ?? {
        server: serverName,
        status: 'disconnected',
        toolCount: 0,
        lastError: null,
        lastCheckedAt: 0,
        failures: 0,
      };
      // Bounded backoff for repeatedly failing servers
      if (prev.status === 'degraded' && Date.now() - prev.lastCheckedAt < Math.min(30000, prev.failures * 3000)) {
        continue;
      }
      prev.status = 'connecting';
      this.health.set(key, prev);
    }

    try {
      const discovered = await this.hub.discoverTools(ws);
      const counts = new Map();
      for (const mt of discovered) {
        counts.set(mt.serverName, (counts.get(mt.serverName) ?? 0) + 1);
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
      for (const serverName of Object.keys(specs)) {
        const key = `${ws}::${serverName}`;
        const count = counts.get(serverName) ?? 0;
        const prev = this.health.get(key);
        this.health.set(key, {
          server: serverName,
          status: count > 0 || prev?.status === 'connecting' ? 'ready' : 'degraded',
          toolCount: count,
          lastError: null,
          lastCheckedAt: Date.now(),
          failures: count > 0 ? 0 : (prev?.failures ?? 0) + 1,
        });
      }
    } catch (err) {
      for (const serverName of Object.keys(specs)) {
        const key = `${ws}::${serverName}`;
        const prev = this.health.get(key);
        this.health.set(key, {
          server: serverName,
          status: 'degraded',
          toolCount: 0,
          lastError: String(err?.message ?? err),
          lastCheckedAt: Date.now(),
          failures: (prev?.failures ?? 0) + 1,
        });
      }
    }
    return tools;
  }

  getStatus() {
    return [...this.health.values()];
  }

  close() {
    for (const h of this.health.values()) {
      h.status = 'closed';
    }
    this.hub.close();
  }
}
