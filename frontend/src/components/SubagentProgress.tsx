import type { Worker } from '../types/backend';
import { subagentOverview, workerStatusLabels } from '../utils/subagentProgress';
import { IconChevronRight } from './Icons';
import { WorkerStatusMark } from './WorkerStatusMark';
import './status-microfeedback.css';

const markStates = Object.keys(workerStatusLabels) as Worker['status'][];
const summaryPriority = [
  'failed', 'running', 'reconciling', 'interrupted', 'parked', 'waiting', 'cancelled', 'unknown', 'done',
] satisfies Worker['status'][];

export function LayeredWorkerStatusMark({ status }: { status: Worker['status'] }) {
  return (
    <span className="worker-status-stack" data-state={status} aria-hidden="true">
      {/* Keep the glyphs mounted so rapid updates retarget the current fade instead of restarting it. */}
      {markStates.map((state) => (
        <span key={state} className="worker-status-layer" data-current={state === status}>
          <WorkerStatusMark status={state} />
        </span>
      ))}
    </span>
  );
}

export function SubagentProgress({ workers, onOpen }: { workers: Worker[]; onOpen: () => void }) {
  const { tasks, completed, failed, description } = subagentOverview(workers);
  if (!tasks.length) return null;
  const states = new Set(tasks.map(({ status }) => status));
  const status = summaryPriority.find((state) => states.has(state)) ?? 'unknown';
  return (
    <button type="button" className="subagent-progress" onClick={onOpen}
      title={description} aria-label={`查看子任务，${tasks.length} 项，${description}`} aria-controls="workspace-inspector">
      <LayeredWorkerStatusMark status={status} />
      <span>子任务</span>
      <span className="tabular-nums">{completed}/{tasks.length} 已完成</span>
      {failed > 0 && <span className="subagent-progress-error">{failed} 项失败</span>}
      <IconChevronRight size={13} aria-hidden="true" />
    </button>
  );
}
