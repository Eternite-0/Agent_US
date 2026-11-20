const pad = (n: number) => String(n).padStart(2, '0');

export function fmtClock(ms?: number): string {
  if (!ms) return '';
  const d = new Date(ms);
  return `${d.getHours()}:${pad(d.getMinutes())}`;
}

export function fmtDayDivider(ms?: number): string {
  if (!ms) return '';
  const d = new Date(ms);
  const now = new Date();
  const time = `${d.getHours()}:${pad(d.getMinutes())}`;
  if (d.toDateString() === now.toDateString()) {
    return `今天 ${time}`;
  }
  const weekdays = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
  const diffDays = Math.floor((now.getTime() - d.getTime()) / 86400000);
  if (diffDays >= 0 && diffDays < 7) {
    return `${weekdays[d.getDay()]} ${time}`;
  }
  return `${d.getMonth() + 1}月${d.getDate()}日 ${time}`;
}

export function fmtDuration(ms?: number): string {
  if (!ms || ms < 0) return '';
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s}秒`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  if (m < 60) return rest ? `${m}分钟 ${rest}秒` : `${m}分钟`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return remM ? `${h}小时 ${remM}分钟` : `${h}小时`;
}

export function fmtRelative(ms?: number): string {
  if (!ms) return '';
  const diff = (Date.now() - ms) / 1000;
  if (diff < 60) return '刚刚';
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)} 天前`;
  const d = new Date(ms);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

export function taskTitle(input: string): string {
  const clean = (input || '').replace(/\s+/g, ' ').trim();
  if (!clean) return '未命名任务';
  return clean.length > 56 ? clean.slice(0, 54) + '…' : clean;
}

export function splitPath(fullPath: string): { dir: string; name: string } {
  const norm = (fullPath || '').replace(/\\/g, '/');
  const idx = norm.lastIndexOf('/');
  if (idx < 0) return { dir: '', name: norm };
  return { dir: norm.slice(0, idx + 1), name: norm.slice(idx + 1) };
}

export function fmtStatusLabel(status: string): string {
  switch (status) {
    case 'planning':
      return '规划中';
    case 'running':
      return '执行中';
    case 'reviewing':
      return '验收中';
    case 'completed':
      return '已完成';
    case 'failed':
      return '失败';
    case 'paused':
      return '已暂停';
    case 'cancelled':
      return '已取消';
    case 'waiting':
      return '等待依赖';
    case 'queued':
      return '排队中';
    case 'done':
      return '已完成';
    case 'interrupted':
      return '已中断';
    case 'pending':
      return '待审批';
    case 'approve':
      return '已批准';
    case 'consumed':
      return '已执行';
    case 'deny':
      return '已拒绝';
    case 'revoked':
      return '已撤销';
    case 'expired':
      return '已过期';
    default:
      return status;
  }
}

export function fmtActionCommand(tool: string, action: Record<string, unknown>): string {
  if (tool === 'shell' || tool === 'pty') {
    const argv = Array.isArray(action.argv) ? action.argv.map(String) : [];
    return argv.join(' ');
  }
  if (tool === 'git') {
    const args = Array.isArray(action.args) ? action.args.map(String) : [];
    return `git ${args.join(' ')}`;
  }
  if (tool === 'write_file') {
    return `write_file ${String(action.path ?? '')}`;
  }
  if (tool === 'read_file') {
    return `read_file ${String(action.path ?? '')}`;
  }
  if (tool === 'mcp') {
    return `${String(action.server ?? 'mcp')}.${String(action.name ?? '')}(${String(action.argumentsJson ?? '{}')})`;
  }
  return JSON.stringify(action);
}

export function fmtUSD(usd: number): string {
  if (!usd || usd < 0.0001) return '$0.0000';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(3)}`;
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function randomIdempotencyKey(): string {
  return `ui-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
