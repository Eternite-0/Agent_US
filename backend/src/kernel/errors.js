import { Fault } from '../store.js';

export const ERROR_CATEGORIES = Object.freeze({
  RUNTIME: 'runtime',
  POLICY: 'policy',
  VALIDATION: 'validation',
  CANCELLATION: 'cancellation',
  BUDGET: 'budget',
  RECOVERY: 'recovery',
  INFERENCE: 'inference',
  TOOL: 'tool',
});

export class RuntimeError extends Fault {
  constructor(
    code,
    {
      status = 500,
      category = ERROR_CATEGORIES.RUNTIME,
      retryable = false,
      message = code,
      detail = undefined,
      cause = undefined,
    } = {},
  ) {
    super(code, status, {
      ...(detail && typeof detail === 'object' ? detail : {}),
      message,
      category,
      retryable: Boolean(retryable),
    });
    this.name = 'RuntimeError';
    this.category = category;
    this.retryable = Boolean(retryable);
    if (cause !== undefined) this.cause = cause;
  }
}

export class PolicyError extends RuntimeError {
  constructor(code, opts = {}) {
    super(code, {
      status: 403,
      category: ERROR_CATEGORIES.POLICY,
      retryable: false,
      ...opts,
    });
    this.name = 'PolicyError';
  }
}

export class ToolValidationError extends RuntimeError {
  constructor(code = 'INVALID_ARGUMENTS', opts = {}) {
    super(code, {
      status: 400,
      category: ERROR_CATEGORIES.VALIDATION,
      retryable: true,
      ...opts,
    });
    this.name = 'ToolValidationError';
  }
}

export class CancellationError extends RuntimeError {
  constructor(code = 'CANCELLED', opts = {}) {
    super(code, {
      status: 499,
      category: ERROR_CATEGORIES.CANCELLATION,
      retryable: false,
      message: opts.message ?? '执行已取消',
      ...opts,
    });
    this.name = 'CancellationError';
  }
}

export class BudgetError extends RuntimeError {
  constructor(code = 'BUDGET_EXCEEDED', opts = {}) {
    super(code, {
      status: 429,
      category: ERROR_CATEGORIES.BUDGET,
      retryable: false,
      ...opts,
    });
    this.name = 'BudgetError';
  }
}

export class RecoveryError extends RuntimeError {
  constructor(code = 'RECOVERY_FAILED', opts = {}) {
    super(code, {
      status: 409,
      category: ERROR_CATEGORIES.RECOVERY,
      retryable: false,
      ...opts,
    });
    this.name = 'RecoveryError';
  }
}

export class InferenceError extends RuntimeError {
  constructor(code = 'INFERENCE_FAILED', opts = {}) {
    super(code, {
      status: opts.status ?? 502,
      category: ERROR_CATEGORIES.INFERENCE,
      retryable: opts.retryable ?? false,
      ...opts,
    });
    this.name = 'InferenceError';
  }
}

const TRANSIENT_MSG_RE =
  /\b(?:ECONNRESET|ETIMEDOUT|EAI_AGAIN|ECONNREFUSED|rate[_ ]?limit|too many requests|429|502|503|504|overloaded|temporarily unavailable|socket hang up|fetch failed)\b/i;

export function classifyError(err) {
  if (!err) {
    return new RuntimeError('UNKNOWN_ERROR', { message: 'Unknown error' });
  }
  if (err instanceof RuntimeError) return err;
  if (err.name === 'AbortError' || err.code === 'ABORT_ERR') {
    return new CancellationError('ABORTED', {
      message: String(err.message || '执行已取消'),
      cause: err,
    });
  }
  if (err instanceof Fault) {
    const code = String(err.code || 'FAULT');
    if (code === 'COST_BUDGET' || code === 'STEP_BUDGET' || code === 'TASK_DEADLINE') {
      return new BudgetError(code, {
        status: err.status ?? 429,
        message: err.detail?.message ?? code,
        detail: err.detail,
        cause: err,
      });
    }
    if (code === 'LEASE_LOST' || code === 'APPROVAL_PARKED' || code === 'RECONCILIATION_ABORTED') {
      return new RecoveryError(code, {
        status: err.status ?? 409,
        message: err.detail?.message ?? code,
        detail: err.detail,
        cause: err,
      });
    }
    if (code === 'POLICY_HARD_BLOCKED' || code === 'APPROVAL_DENIED' || code === 'E_EXECUTE_PERMIT') {
      return new PolicyError(code, {
        status: err.status ?? 403,
        message: err.detail?.message ?? err.message ?? code,
        detail: err.detail,
        cause: err,
      });
    }
    return new RuntimeError(code, {
      status: err.status ?? 500,
      retryable: err.status === 429 || err.status >= 502,
      message: err.detail?.message ?? err.message ?? code,
      detail: err.detail,
      cause: err,
    });
  }

  const msg = String(err?.message ?? err);
  const status = Number(err?.status ?? err?.statusCode ?? 0) || 500;
  const retryable = status === 429 || status === 502 || status === 503 || status === 504 || TRANSIENT_MSG_RE.test(msg);
  if (retryable) {
    return new InferenceError('TRANSIENT_UPSTREAM_ERROR', {
      status,
      retryable: true,
      message: msg,
      cause: err,
    });
  }
  return new RuntimeError(String(err?.code || 'INTERNAL_ERROR'), {
    status,
    retryable: false,
    message: msg,
    cause: err,
  });
}
