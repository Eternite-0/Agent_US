/**
 * Ordered, idempotent async ShutdownCoordinator with per-stage timeout guards.
 * Concurrent or repeated calls to `shutdown()` await the exact same shutdown promise
 * so resources (workers, processes, worktrees, MCP, SQLite) are never double-closed.
 */
export class ShutdownCoordinator {
  constructor() {
    this.stages = [];
    this.syncHooks = [];
    this.shuttingDown = false;
    this.shutdownPromise = null;
    this.lastReport = null;
  }

  registerSyncHook(fn) {
    if (typeof fn === 'function') this.syncHooks.push(fn);
  }

  registerStage(name, fn, { order = 50, timeoutMs = 5000 } = {}) {
    if (typeof fn !== 'function') return;
    this.stages.push({
      name: String(name),
      fn,
      order: Number(order),
      timeoutMs: Math.max(100, Number(timeoutMs || 5000)),
    });
  }

  runSyncHooks() {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    for (const fn of this.syncHooks) {
      try {
        fn();
      } catch {
        // isolate sync hook errors so shutdown always progresses
      }
    }
  }

  async shutdown() {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.runSyncHooks();

    const ordered = [...this.stages].sort((a, b) => a.order - b.order);
    const totalStart = Date.now();

    this.shutdownPromise = (async () => {
      const results = [];
      for (const stage of ordered) {
        const start = Date.now();
        let timer = null;
        try {
          await Promise.race([
            Promise.resolve().then(() => stage.fn()),
            new Promise((_, reject) => {
              timer = setTimeout(() => {
                reject(new Error(`Shutdown stage "${stage.name}" timed out after ${stage.timeoutMs}ms`));
              }, stage.timeoutMs);
              timer.unref?.();
            }),
          ]);
          results.push({
            name: stage.name,
            ok: true,
            durationMs: Date.now() - start,
            error: null,
          });
        } catch (err) {
          results.push({
            name: stage.name,
            ok: false,
            durationMs: Date.now() - start,
            error: String(err?.message ?? err),
          });
        } finally {
          if (timer) clearTimeout(timer);
        }
      }

      const report = {
        ok: results.every((r) => r.ok),
        durationMs: Date.now() - totalStart,
        stages: results,
      };
      this.lastReport = report;
      return report;
    })();

    return this.shutdownPromise;
  }
}
