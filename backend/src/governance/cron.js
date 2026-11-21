import { Fault } from '../store.js';

export const SCHEDULE_KINDS = new Set(['interval', 'hourly', 'daily', 'weekly', 'cron']);
export const CONCURRENCY_POLICIES = new Set(['skip', 'queue', 'allow']);
export const MISFIRE_POLICIES = new Set(['fire_once', 'skip', 'catch_up']);

const WEEKDAY_MAP = Object.freeze({
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
});

const FORMATTER_CACHE = new Map();

function getFormatter(timeZone) {
  let fmt = FORMATTER_CACHE.get(timeZone);
  if (fmt) return fmt;
  try {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
      hourCycle: 'h23',
    });
  } catch {
    throw new Fault('INVALID_SCHEDULE_CONFIG', 400, {
      message: `Invalid IANA timezone: ${timeZone}`,
    });
  }
  if (FORMATTER_CACHE.size < 64) FORMATTER_CACHE.set(timeZone, fmt);
  return fmt;
}

export function validateTimezone(timeZone = 'UTC') {
  const tz = String(timeZone || 'UTC').trim() || 'UTC';
  getFormatter(tz);
  return tz;
}

export function getZonedParts(ms, timeZone = 'UTC') {
  const fmt = getFormatter(timeZone);
  const parts = fmt.formatToParts(new Date(ms));
  const out = {};
  for (const p of parts) {
    if (p.type !== 'literal') out[p.type] = p.value;
  }
  const hour = Number(out.hour);
  return {
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    hour: hour === 24 ? 0 : hour,
    minute: Number(out.minute),
    weekday: WEEKDAY_MAP[String(out.weekday || '').toLowerCase().slice(0, 3)] ?? 0,
  };
}

/**
 * Returns true if `ms` falls in the second (repeated) fold of a DST fall-back
 * transition in `timeZone` (i.e. an earlier instant 30 or 60 minutes prior
 * mapped to the exact same local wall-clock year/month/day/hour/minute).
 */
export function isSecondDstFold(ms, timeZone = 'UTC') {
  const tz = validateTimezone(timeZone);
  const cur = getZonedParts(ms, tz);
  for (const delta of [1_800_000, 3_600_000]) {
    const prev = getZonedParts(ms - delta, tz);
    if (
      prev.year === cur.year &&
      prev.month === cur.month &&
      prev.day === cur.day &&
      prev.hour === cur.hour &&
      prev.minute === cur.minute
    ) {
      return true;
    }
  }
  return false;
}

function parseCronField(fieldExpr, min, max, { normalizeDow = false } = {}) {
  const raw = String(fieldExpr ?? '').trim();
  if (!raw) {
    throw new Fault('INVALID_SCHEDULE_CONFIG', 400, { message: 'Empty cron field' });
  }
  const out = new Set();
  for (const token of raw.split(',')) {
    const part = token.trim();
    if (!part) {
      throw new Fault('INVALID_SCHEDULE_CONFIG', 400, { message: `Invalid cron token in "${raw}"` });
    }
    const [rangePart, stepPart] = part.split('/');
    if (part.split('/').length > 2) {
      throw new Fault('INVALID_SCHEDULE_CONFIG', 400, { message: `Invalid cron step "${part}"` });
    }
    let step = 1;
    if (stepPart !== undefined) {
      if (!/^\d+$/.test(stepPart) || Number(stepPart) < 1) {
        throw new Fault('INVALID_SCHEDULE_CONFIG', 400, {
          message: `Cron step must be positive integer: "${part}"`,
        });
      }
      step = Number(stepPart);
    }

    let start = min;
    let end = max;
    if (rangePart === '*') {
      start = min;
      end = max;
    } else if (rangePart.includes('-')) {
      const bounds = rangePart.split('-');
      if (bounds.length !== 2 || !/^\d+$/.test(bounds[0]) || !/^\d+$/.test(bounds[1])) {
        throw new Fault('INVALID_SCHEDULE_CONFIG', 400, {
          message: `Invalid cron range "${part}"`,
        });
      }
      start = Number(bounds[0]);
      end = Number(bounds[1]);
      if (start > end || start < min || end > max) {
        throw new Fault('INVALID_SCHEDULE_CONFIG', 400, {
          message: `Cron range out of bounds [${min}-${max}]: "${part}"`,
        });
      }
    } else {
      if (!/^\d+$/.test(rangePart)) {
        throw new Fault('INVALID_SCHEDULE_CONFIG', 400, {
          message: `Invalid cron value "${part}"`,
        });
      }
      start = Number(rangePart);
      end = stepPart !== undefined ? max : start;
      if (start < min || start > max) {
        throw new Fault('INVALID_SCHEDULE_CONFIG', 400, {
          message: `Cron value out of bounds [${min}-${max}]: "${part}"`,
        });
      }
    }

    for (let v = start; v <= end; v += step) {
      out.add(normalizeDow && v === 7 ? 0 : v);
    }
  }
  if (!out.size) {
    throw new Fault('INVALID_SCHEDULE_CONFIG', 400, { message: `Cron field matched no values: "${raw}"` });
  }
  return out;
}

export function validateScheduleConfig({
  scheduleKind = 'daily',
  scheduleExpr = '09:00',
  timezone = 'UTC',
  concurrencyPolicy = 'skip',
  misfirePolicy = 'fire_once',
  maxConcurrency = 1,
} = {}) {
  const kind = String(scheduleKind || '').toLowerCase();
  const expr = String(scheduleExpr ?? '').trim();
  if (!SCHEDULE_KINDS.has(kind)) {
    throw new Fault('INVALID_SCHEDULE_CONFIG', 400, {
      message: `Unsupported scheduleKind "${scheduleKind}"`,
    });
  }
  const tz = validateTimezone(timezone);
  if (!CONCURRENCY_POLICIES.has(String(concurrencyPolicy))) {
    throw new Fault('INVALID_SCHEDULE_CONFIG', 400, {
      message: `Invalid concurrencyPolicy "${concurrencyPolicy}"`,
    });
  }
  if (!MISFIRE_POLICIES.has(String(misfirePolicy))) {
    throw new Fault('INVALID_SCHEDULE_CONFIG', 400, {
      message: `Invalid misfirePolicy "${misfirePolicy}"`,
    });
  }
  const maxConc = Number(maxConcurrency ?? 1);
  if (!Number.isInteger(maxConc) || maxConc < 1 || maxConc > 32) {
    throw new Fault('INVALID_SCHEDULE_CONFIG', 400, {
      message: `maxConcurrency must be an integer between 1 and 32`,
    });
  }

  if (kind === 'interval') {
    const m = /^(\d+)\s*(ms|s|m|h|d)?$/i.exec(expr);
    if (!m || Number(m[1]) < 1) {
      throw new Fault('INVALID_SCHEDULE_CONFIG', 400, {
        message: `Invalid interval expression "${expr}"`,
      });
    }
    const mult =
      m[2]?.toLowerCase() === 'ms'
        ? 1
        : m[2]?.toLowerCase() === 'm'
          ? 60_000
          : m[2]?.toLowerCase() === 'h'
            ? 3_600_000
            : m[2]?.toLowerCase() === 'd'
              ? 86_400_000
              : 1000;
    const ms = Number(m[1]) * mult;
    if (ms < 50) {
      throw new Fault('INVALID_SCHEDULE_CONFIG', 400, {
        message: `Interval must be at least 50ms`,
      });
    }
    return { kind, expr, tz, intervalMs: ms, maxConc };
  }

  if (kind === 'hourly') {
    if (expr && !/^:?(\d{1,2})$/.test(expr)) {
      throw new Fault('INVALID_SCHEDULE_CONFIG', 400, {
        message: `Invalid hourly minute "${expr}" (expected 0-59)`,
      });
    }
    const min = expr ? Number(expr.replace(/^:/, '')) : 0;
    if (!Number.isInteger(min) || min < 0 || min > 59) {
      throw new Fault('INVALID_SCHEDULE_CONFIG', 400, {
        message: `Invalid hourly minute "${expr}" (expected 0-59)`,
      });
    }
    return { kind, expr: String(min), tz, minute: min, maxConc };
  }

  if (kind === 'daily') {
    const m = /^(\d{1,2}):(\d{2})$/.exec(expr);
    if (!m) {
      throw new Fault('INVALID_SCHEDULE_CONFIG', 400, {
        message: `Daily schedule must be HH:MM, got "${expr}"`,
      });
    }
    const hour = Number(m[1]);
    const minute = Number(m[2]);
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
      throw new Fault('INVALID_SCHEDULE_CONFIG', 400, {
        message: `Daily HH:MM out of range: "${expr}"`,
      });
    }
    return { kind, expr, tz, hour, minute, maxConc };
  }

  if (kind === 'weekly') {
    const m = /^(?:(\d|sun|mon|tue|wed|thu|fri|sat)\s+)?(\d{1,2}):(\d{2})$/i.exec(expr);
    if (!m) {
      throw new Fault('INVALID_SCHEDULE_CONFIG', 400, {
        message: `Weekly schedule must be "[DAY ]HH:MM", got "${expr}"`,
      });
    }
    const dow =
      m[1] === undefined
        ? 1
        : /^\d$/.test(m[1])
          ? Number(m[1])
          : WEEKDAY_MAP[m[1].toLowerCase()];
    const hour = Number(m[2]);
    const minute = Number(m[3]);
    if (dow < 0 || dow > 6 || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
      throw new Fault('INVALID_SCHEDULE_CONFIG', 400, {
        message: `Weekly expression out of range: "${expr}"`,
      });
    }
    return { kind, expr, tz, dow, hour, minute, maxConc };
  }

  // 5-field cron
  const fields = expr.split(/\s+/);
  if (fields.length !== 5) {
    throw new Fault('INVALID_SCHEDULE_CONFIG', 400, {
      message: `Cron expression must have 5 fields, got ${fields.length}: "${expr}"`,
    });
  }
  const hours = parseCronField(fields[1], 0, 23);
  const parsed = {
    minutes: parseCronField(fields[0], 0, 59),
    hours,
    dom: parseCronField(fields[2], 1, 31),
    months: parseCronField(fields[3], 1, 12),
    dow: parseCronField(fields[4], 0, 7, { normalizeDow: true }),
    hoursWildcard: fields[1] === '*' || hours.size >= 24,
    domWildcard: fields[2] === '*',
    dowWildcard: fields[4] === '*',
  };
  return { kind, expr, tz, cron: parsed, maxConc };
}

function matchDay(parts, cron) {
  if (!cron.months.has(parts.month)) return false;
  const domMatch = cron.dom.has(parts.day);
  const dowMatch = cron.dow.has(parts.weekday);
  // Standard POSIX cron day matching semantics when either DOM or DOW is restricted
  return cron.domWildcard || cron.dowWildcard ? domMatch && dowMatch : domMatch || dowMatch;
}

function matchDateParts(parts, cron) {
  if (!matchDay(parts, cron)) return false;
  return cron.hours.has(parts.hour) && cron.minutes.has(parts.minute);
}

/**
 * Advances an interval anchor in O(1) strictly past `afterMs` while preserving cadence phase.
 */
export function advanceIntervalPast(anchorMs, intervalMs, afterMs) {
  if (anchorMs > afterMs) return anchorMs;
  const steps = Math.floor((afterMs - anchorMs) / intervalMs) + 1;
  return anchorMs + steps * intervalMs;
}

const MAX_SCAN_DAYS = 1830;

/**
 * Computes the next firing epoch in milliseconds strictly > `fromMs` using `timezone`.
 */
export function computeNextRunAt(
  scheduleKind,
  scheduleExpr,
  fromMs = Date.now(),
  { timezone = 'UTC' } = {},
) {
  const cfg = validateScheduleConfig({ scheduleKind, scheduleExpr, timezone });

  if (cfg.kind === 'interval') {
    return fromMs + cfg.intervalMs;
  }

  let cursor = Math.floor(fromMs / 60_000) * 60_000 + 60_000;
  const maxCursor = fromMs + MAX_SCAN_DAYS * 86_400_000;

  while (cursor <= maxCursor) {
    const p = getZonedParts(cursor, cfg.tz);
    if (cfg.kind === 'hourly') {
      if (p.minute === cfg.minute) return cursor;
      cursor += 60_000;
      continue;
    }
    if (cfg.kind === 'daily') {
      if (p.hour === cfg.hour && p.minute === cfg.minute) {
        if (!isSecondDstFold(cursor, cfg.tz)) return cursor;
      }
      if (p.hour !== cfg.hour) {
        cursor += (60 - p.minute) * 60_000;
      } else {
        cursor += 60_000;
      }
      continue;
    }
    if (cfg.kind === 'weekly') {
      if (p.weekday === cfg.dow && p.hour === cfg.hour && p.minute === cfg.minute) {
        if (!isSecondDstFold(cursor, cfg.tz)) return cursor;
      }
      if (p.weekday !== cfg.dow) {
        cursor +=
          p.hour < 20
            ? (21 - p.hour) * 3_600_000 - p.minute * 60_000
            : (60 - p.minute) * 60_000;
      } else if (p.hour !== cfg.hour) {
        cursor += (60 - p.minute) * 60_000;
      } else {
        cursor += 60_000;
      }
      continue;
    }

    // 5-field cron with DST-safe day/hour skip
    if (!matchDay(p, cfg.cron)) {
      cursor +=
        p.hour < 20
          ? (21 - p.hour) * 3_600_000 - p.minute * 60_000
          : (60 - p.minute) * 60_000;
      continue;
    }
    if (!cfg.cron.hours.has(p.hour)) {
      cursor += (60 - p.minute) * 60_000;
      continue;
    }
    if (matchDateParts(p, cfg.cron)) {
      if (cfg.cron.hoursWildcard || !isSecondDstFold(cursor, cfg.tz)) {
        return cursor;
      }
    }
    cursor += 60_000;
  }

  throw new Fault('INVALID_SCHEDULE_CONFIG', 400, {
    message: `No valid trigger found within ${MAX_SCAN_DAYS} days for "${scheduleExpr}" (${timezone})`,
  });
}
