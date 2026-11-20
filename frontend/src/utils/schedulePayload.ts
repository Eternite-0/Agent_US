import type { BackendScheduleRecord } from '../types/backend';

export type ScheduleFrequency = 'daily' | 'weekly' | 'hourly' | 'cron';
export type ScheduleConcurrencyPolicy = 'skip' | 'queue' | 'allow';
export type ScheduleMisfirePolicy = 'fire_once' | 'skip' | 'catch_up';

export interface ScheduledTaskItem {
  id: string;
  title: string;
  prompt: string;
  projectId: string | null;
  frequency: ScheduleFrequency;
  hourlyMinute: number;
  time: string;
  weekday: string;
  cronExpr: string;
  timezone: string;
  concurrencyPolicy?: ScheduleConcurrencyPolicy;
  misfirePolicy?: ScheduleMisfirePolicy;
  maxConcurrency?: number;
  paused: boolean;
  nextRunAt: number | null;
  lastRunAt: number | null;
  lastStatus: string | null;
  lastRunTaskIds: string[];
  createdAt: number;
}

export type ScheduleDraftInput = Omit<
  ScheduledTaskItem,
  'id' | 'nextRunAt' | 'lastRunAt' | 'lastStatus' | 'lastRunTaskIds' | 'createdAt'
>;

export interface CreateSchedulePayload {
  name: string;
  prompt: string;
  scheduleKind: ScheduleFrequency;
  scheduleExpr: string;
  timezone: string;
  concurrencyPolicy?: ScheduleConcurrencyPolicy;
  misfirePolicy?: ScheduleMisfirePolicy;
  maxConcurrency?: number;
  workspaceRoot?: string;
  model?: string;
  permissionMode?: string;
  enabled: boolean;
}

export type UpdateSchedulePayload = Partial<{
  name: string;
  prompt: string;
  scheduleKind: ScheduleFrequency;
  scheduleExpr: string;
  timezone: string;
  concurrencyPolicy: ScheduleConcurrencyPolicy;
  misfirePolicy: ScheduleMisfirePolicy;
  maxConcurrency: number;
  workspaceRoot: string | null;
  model: string | null;
  permissionMode: string;
  enabled: boolean;
}>;

const WEEKDAY_ZH_TO_CRON: Record<string, string> = {
  日: 'sun',
  一: 'mon',
  二: 'tue',
  三: 'wed',
  四: 'thu',
  五: 'fri',
  六: 'sat',
};

const WEEKDAY_TOKEN_TO_ZH: Record<string, string> = {
  '0': '日',
  '1': '一',
  '2': '二',
  '3': '三',
  '4': '四',
  '5': '五',
  '6': '六',
  sun: '日',
  mon: '一',
  tue: '二',
  wed: '三',
  thu: '四',
  fri: '五',
  sat: '六',
  日: '日',
  一: '一',
  二: '二',
  三: '三',
  四: '四',
  五: '五',
  六: '六',
};

export const COMMON_IANA_TIMEZONES: readonly string[] = [
  'UTC',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'Europe/London',
  'Europe/Berlin',
  'Europe/Paris',
  'Asia/Shanghai',
  'Asia/Tokyo',
  'Asia/Singapore',
  'Asia/Seoul',
  'Asia/Kolkata',
  'Australia/Sydney',
  'Pacific/Auckland',
];

export function getDefaultTimezone(): string {
  try {
    const resolved = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (resolved && resolved.trim()) return resolved.trim();
  } catch {
    // Fallback to UTC when runtime cannot resolve local IANA zone
  }
  return 'UTC';
}

export function getTimezoneOptions(savedTimezone?: string | null): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (tz?: string | null) => {
    const clean = String(tz ?? '').trim();
    if (!clean || seen.has(clean)) return;
    seen.add(clean);
    out.push(clean);
  };
  push(savedTimezone);
  push(getDefaultTimezone());
  for (const tz of COMMON_IANA_TIMEZONES) push(tz);
  return out;
}

export function normalizeHourlyMinute(value: unknown): number {
  const num = Number(value ?? 0);
  if (!Number.isFinite(num)) return 0;
  return Math.min(59, Math.max(0, Math.trunc(num)));
}

export function buildScheduleExpr(
  item: Pick<ScheduledTaskItem, 'frequency' | 'hourlyMinute' | 'time' | 'weekday' | 'cronExpr'>,
): string {
  if (item.frequency === 'hourly') {
    return String(normalizeHourlyMinute(item.hourlyMinute));
  }
  if (item.frequency === 'daily') {
    return String(item.time || '09:00').trim();
  }
  if (item.frequency === 'weekly') {
    const rawDay = String(item.weekday || '一').trim();
    const cronDay = WEEKDAY_ZH_TO_CRON[rawDay] ?? rawDay.toLowerCase();
    const cleanTime = String(item.time || '09:00').trim();
    return `${cronDay} ${cleanTime}`;
  }
  return String(item.cronExpr || '').trim();
}

export function buildCreateSchedulePayload(
  item: ScheduleDraftInput,
  runtimeDefaults?: {
    workspaceRoot?: string;
    model?: string;
    permissionMode?: string;
  },
): CreateSchedulePayload {
  const explicitTz = String(item.timezone ?? '').trim() || getDefaultTimezone();
  return {
    name: String(item.title ?? '').trim(),
    prompt: String(item.prompt ?? '').trim(),
    scheduleKind: item.frequency,
    scheduleExpr: buildScheduleExpr(item),
    timezone: explicitTz,
    ...(item.concurrencyPolicy ? { concurrencyPolicy: item.concurrencyPolicy } : {}),
    ...(item.misfirePolicy ? { misfirePolicy: item.misfirePolicy } : {}),
    ...(item.maxConcurrency !== undefined ? { maxConcurrency: item.maxConcurrency } : {}),
    ...(runtimeDefaults?.workspaceRoot ? { workspaceRoot: runtimeDefaults.workspaceRoot } : {}),
    ...(runtimeDefaults?.model ? { model: runtimeDefaults.model } : {}),
    ...(runtimeDefaults?.permissionMode ? { permissionMode: runtimeDefaults.permissionMode } : {}),
    enabled: !item.paused,
  };
}

export function buildUpdateSchedulePayload(
  patch: Partial<ScheduledTaskItem>,
  current?: ScheduledTaskItem | null,
): UpdateSchedulePayload {
  const out: UpdateSchedulePayload = {};
  if (patch.title !== undefined) out.name = String(patch.title).trim();
  if (patch.prompt !== undefined) out.prompt = String(patch.prompt).trim();
  if (patch.paused !== undefined) out.enabled = !patch.paused;
  if (patch.timezone !== undefined) {
    const cleanTz = String(patch.timezone).trim();
    if (cleanTz) out.timezone = cleanTz;
  }
  if (patch.concurrencyPolicy !== undefined) out.concurrencyPolicy = patch.concurrencyPolicy;
  if (patch.misfirePolicy !== undefined) out.misfirePolicy = patch.misfirePolicy;
  if (patch.maxConcurrency !== undefined) out.maxConcurrency = patch.maxConcurrency;

  const touchesTiming =
    patch.frequency !== undefined ||
    patch.hourlyMinute !== undefined ||
    patch.time !== undefined ||
    patch.weekday !== undefined ||
    patch.cronExpr !== undefined;

  if (touchesTiming) {
    const merged = {
      frequency: patch.frequency ?? current?.frequency ?? 'daily',
      hourlyMinute: patch.hourlyMinute ?? current?.hourlyMinute ?? 0,
      time: patch.time ?? current?.time ?? '09:00',
      weekday: patch.weekday ?? current?.weekday ?? '一',
      cronExpr: patch.cronExpr ?? current?.cronExpr ?? '0 9 * * 1-5',
    };
    out.scheduleKind = merged.frequency;
    out.scheduleExpr = buildScheduleExpr(merged);
  }

  return out;
}

export function hydrateScheduleItem(s: BackendScheduleRecord): ScheduledTaskItem {
  const freq: ScheduleFrequency =
    s.scheduleKind === 'hourly' ||
    s.scheduleKind === 'daily' ||
    s.scheduleKind === 'weekly' ||
    s.scheduleKind === 'cron'
      ? s.scheduleKind
      : 'cron';

  let hourlyMinute = 0;
  let time = '09:00';
  let weekday = '一';
  let cronExpr = s.scheduleExpr || '0 9 * * 1-5';

  if (freq === 'hourly') {
    const parsed = Number(String(s.scheduleExpr ?? '0').replace(/^:/, ''));
    hourlyMinute = Number.isInteger(parsed) && parsed >= 0 && parsed <= 59 ? parsed : 0;
    cronExpr = '0 9 * * 1-5';
  } else if (freq === 'daily') {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(s.scheduleExpr ?? '').trim());
    if (m) time = `${m[1].padStart(2, '0')}:${m[2]}`;
    cronExpr = '0 9 * * 1-5';
  } else if (freq === 'weekly') {
    const m = /^(?:(\d|sun|mon|tue|wed|thu|fri|sat)\s+)?(\d{1,2}):(\d{2})$/i.exec(
      String(s.scheduleExpr ?? '').trim(),
    );
    if (m) {
      const token = (m[1] ?? 'mon').toLowerCase();
      weekday = WEEKDAY_TOKEN_TO_ZH[token] ?? '一';
      time = `${m[2].padStart(2, '0')}:${m[3]}`;
    }
    cronExpr = '0 9 * * 1-5';
  }

  const savedTz = s.timezone && s.timezone.trim() ? s.timezone.trim() : 'UTC';
  const conc: ScheduleConcurrencyPolicy =
    s.concurrencyPolicy === 'queue' || s.concurrencyPolicy === 'allow'
      ? s.concurrencyPolicy
      : 'skip';
  const misfire: ScheduleMisfirePolicy =
    s.misfirePolicy === 'skip' || s.misfirePolicy === 'catch_up'
      ? s.misfirePolicy
      : 'fire_once';

  return {
    id: s.id,
    title: s.name,
    prompt: s.prompt,
    projectId: null,
    frequency: freq,
    hourlyMinute,
    time,
    weekday,
    cronExpr,
    timezone: savedTz,
    concurrencyPolicy: conc,
    misfirePolicy: misfire,
    maxConcurrency: Number(s.maxConcurrency ?? 1),
    paused: !s.enabled,
    nextRunAt: s.nextRunAt ?? null,
    lastRunAt: s.lastRunAt ?? null,
    lastStatus: s.lastStatus ?? null,
    lastRunTaskIds: (s.runHistory ?? []).map((h) => h.sessionId).filter(Boolean),
    createdAt: s.createdAt ?? Date.now(),
  };
}

export function formatNextRunAt(ms: number | null | undefined, timezone?: string | null): string {
  if (!ms || !Number.isFinite(ms)) return '—';
  const tz = String(timezone ?? '').trim() || 'UTC';
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString();
  }
}
