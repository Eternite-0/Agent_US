import { redactSecrets } from '../envelope.js';
import { compactTrace } from './trace.js';

const LEVEL_PRIORITY = Object.freeze({
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
});

const SENSITIVE_KEY_RE =
  /^(?:authorization|x-api-key|api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|bearer|secret|client[_-]?secret|password|passwd|private[_-]?key|credential(?:enc)?|token)$/i;

export function getLogLevel() {
  const envLevel = String(process.env.LOG_LEVEL ?? '').trim().toLowerCase();
  if (envLevel && Object.hasOwn(LEVEL_PRIORITY, envLevel)) {
    return envLevel;
  }
  if (
    process.env.NODE_ENV === 'test' ||
    Boolean(process.env.NODE_TEST_CONTEXT) ||
    (Array.isArray(process.execArgv) && process.execArgv.includes('--test'))
  ) {
    return 'silent';
  }
  return 'info';
}

function redactValue(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactSecrets(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (depth >= 6) return '[TRUNCATED]';

  if (value instanceof Error) {
    const out = {
      name: value.name || 'Error',
      message: redactSecrets(String(value.message || '')),
    };
    if (value.code !== undefined) out.code = String(value.code);
    if (value.status !== undefined) out.status = Number(value.status);
    return out;
  }

  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => redactValue(item, depth + 1));
  }

  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) continue;
      if (SENSITIVE_KEY_RE.test(k)) {
        out[k] = '[REDACTED]';
      } else {
        out[k] = redactValue(v, depth + 1);
      }
    }
    return out;
  }

  return redactSecrets(String(value));
}

/**
 * Emits a single-line redacted NDJSON structured log entry with automatic
 * AsyncLocalStorage trace context correlation. Never throws.
 */
export function logEvent(level, event, fields = {}, options = {}) {
  try {
    const normLevel = Object.hasOwn(LEVEL_PRIORITY, String(level || '').toLowerCase())
      ? String(level).toLowerCase()
      : 'info';
    const configured =
      options.level && Object.hasOwn(LEVEL_PRIORITY, String(options.level).toLowerCase())
        ? String(options.level).toLowerCase()
        : getLogLevel();

    if (configured === 'silent' || LEVEL_PRIORITY[normLevel] < LEVEL_PRIORITY[configured]) {
      return null;
    }

    const trace = compactTrace();
    const cleanFields = fields && typeof fields === 'object' ? redactValue(fields, 0) : {};
    const record = {
      ts: new Date().toISOString(),
      level: normLevel,
      event: redactSecrets(String(event || 'runtime.event')),
      ...trace,
      ...cleanFields,
    };

    const line = `${JSON.stringify(record)}\n`;
    const stream =
      options.stream ??
      (normLevel === 'error' || normLevel === 'warn' ? process.stderr : process.stdout);
    if (stream && typeof stream.write === 'function') {
      stream.write(line);
    }
    return record;
  } catch {
    return null;
  }
}

export const logger = Object.freeze({
  debug: (event, fields, options) => logEvent('debug', event, fields, options),
  info: (event, fields, options) => logEvent('info', event, fields, options),
  warn: (event, fields, options) => logEvent('warn', event, fields, options),
  error: (event, fields, options) => logEvent('error', event, fields, options),
  log: logEvent,
});
