import type { Worker } from '../types/backend';

export function swarmWorkerStatus(status: string): Worker['status'] {
  switch (status) {
    case 'completed': return 'done';
    case 'pending':
    case 'ready':
    case 'queued': return 'waiting';
    case 'running':
    case 'failed':
    case 'interrupted':
    case 'cancelled':
    case 'parked':
    case 'reconciling': return status;
    default: return 'unknown';
  }
}

export const workerStatusLabels = {
  running: '运行中', waiting: '等待中', parked: '已挂起', reconciling: '恢复中',
  failed: '失败', interrupted: '已中断', cancelled: '已取消', unknown: '状态未知', done: '已完成',
} satisfies Record<Worker['status'], string>;

/** Call with one task bundle. Control-plane event records have no assignment. */
export function subagentGroups(workers: readonly Worker[]) {
  const latest = new Map<string, Worker>();
  for (const worker of workers) {
    if (!worker.assignmentId) continue;
    const previous = latest.get(worker.assignmentId);
    if (!previous || worker.attempt > previous.attempt ||
        (worker.attempt === previous.attempt && worker.version >= previous.version)) {
      latest.set(worker.assignmentId, worker);
    }
  }
  const groups = new Map<Worker['status'], Worker[]>();
  for (const worker of latest.values()) {
    const group = groups.get(worker.status);
    if (group) group.push(worker);
    else groups.set(worker.status, [worker]);
  }
  return (Object.keys(workerStatusLabels) as Worker['status'][]).flatMap((status) => {
    const members = groups.get(status);
    return members ? [{ status, label: workerStatusLabels[status], members }] : [];
  });
}

/** One visible row per assignment. Previous attempts and runtime events remain inspectable. */
export function subagentOverview(workers: readonly Worker[]) {
  const groups = subagentGroups(workers);
  const tasks = groups.flatMap(({ members }) => members);
  const currentIds = new Set(tasks.map(worker => worker.id));
  const historyById = new Map<string, Worker>();
  for (const worker of workers) {
    if (currentIds.has(worker.id)) continue;
    const previous = historyById.get(worker.id);
    if (!previous || worker.version >= previous.version) historyById.set(worker.id, worker);
  }
  return {
    tasks,
    history: Array.from(historyById.values()),
    completed: groups.find(group => group.status === 'done')?.members.length ?? 0,
    failed: groups.find(group => group.status === 'failed')?.members.length ?? 0,
    description: groups.map(({ label, members }) => `${members.length} ${label}`).join(' · '),
  };
}
