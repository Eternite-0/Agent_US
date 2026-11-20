import { CancellationError } from './errors.js';

/**
 * Hierarchical cancellation epoch tree (clean-room Agnes child/lifecycle.ts pattern).
 * Aborting a parent epoch cascades immediately to all descendant epochs.
 * Cancelled epochs cannot be silently revived.
 */
export class CancellationManager {
  #epochs = new Map(); // id -> { id, controller, parentId, children: Set, timer, cancelled, reason, detachParent }

  createEpoch(id, { parentId = null, externalSignal = null, timeoutMs = null } = {}) {
    const existing = this.#epochs.get(id);
    if (existing && !existing.cancelled) {
      return existing.controller.signal;
    }
    if (existing && existing.cancelled) {
      throw new CancellationError('EPOCH_ALREADY_CANCELLED', {
        message: `Execution epoch ${id} has already been cancelled`,
      });
    }

    const controller = new AbortController();
    const entry = {
      id,
      controller,
      parentId: parentId ?? null,
      children: new Set(),
      timer: null,
      cancelled: false,
      reason: null,
      detachParent: null,
      detachExternal: null,
    };
    this.#epochs.set(id, entry);

    if (parentId) {
      const parent = this.#epochs.get(parentId);
      if (parent) {
        parent.children.add(id);
        const onParentAbort = () => {
          this.cancel(id, parent.reason || 'parent_cancelled');
        };
        if (parent.cancelled || parent.controller.signal.aborted) {
          onParentAbort();
        } else {
          parent.controller.signal.addEventListener('abort', onParentAbort, { once: true });
          entry.detachParent = () =>
            parent.controller.signal.removeEventListener('abort', onParentAbort);
        }
      }
    }

    if (externalSignal) {
      const onExtAbort = () => {
        this.cancel(id, externalSignal.reason || 'external_signal_aborted');
      };
      if (externalSignal.aborted) {
        onExtAbort();
      } else {
        externalSignal.addEventListener('abort', onExtAbort, { once: true });
        entry.detachExternal = () =>
          externalSignal.removeEventListener('abort', onExtAbort);
      }
    }

    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      entry.timer = setTimeout(() => {
        this.cancel(id, 'timeout');
      }, timeoutMs);
      entry.timer.unref?.();
    }

    return controller.signal;
  }

  getSignal(id) {
    return this.#epochs.get(id)?.controller.signal ?? null;
  }

  isCancelled(id) {
    const e = this.#epochs.get(id);
    return Boolean(e?.cancelled || e?.controller.signal.aborted);
  }

  assertActive(id) {
    if (this.isCancelled(id)) {
      const e = this.#epochs.get(id);
      throw new CancellationError('EPOCH_CANCELLED', {
        message: `Execution cancelled (${e?.reason || 'cancelled'})`,
      });
    }
  }

  cancel(id, reason = 'cancelled') {
    const entry = this.#epochs.get(id);
    if (!entry) return false;
    if (!entry.cancelled) {
      entry.cancelled = true;
      entry.reason = reason;
      if (entry.timer) {
        clearTimeout(entry.timer);
        entry.timer = null;
      }
      entry.detachParent?.();
      entry.detachExternal?.();
      entry.detachParent = null;
      entry.detachExternal = null;
      if (!entry.controller.signal.aborted) {
        entry.controller.abort(
          new CancellationError('EPOCH_CANCELLED', { message: String(reason) }),
        );
      }
    }
    for (const childId of [...entry.children]) {
      this.cancel(childId, `parent:${reason}`);
    }
    return true;
  }

  dispose(id) {
    const entry = this.#epochs.get(id);
    if (!entry) return;
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    entry.detachParent?.();
    entry.detachExternal?.();
    if (entry.parentId) {
      this.#epochs.get(entry.parentId)?.children.delete(id);
    }
    this.#epochs.delete(id);
  }

  closeAll() {
    for (const id of [...this.#epochs.keys()]) {
      this.cancel(id, 'runtime_closed');
      this.dispose(id);
    }
  }
}
