import type { Worker } from '../types/backend';
import { subagentOverview } from '../utils/subagentProgress';
import { IconAgentTeam, IconChevronRight } from './Icons';

export function SubagentProgress({ workers, onOpen }: { workers: Worker[]; onOpen: () => void }) {
  const { tasks, completed, failed, description } = subagentOverview(workers);
  if (!tasks.length) return null;
  return (
    <button type="button" className="subagent-progress" onClick={onOpen}
      title={description} aria-label={`查看子任务，${tasks.length} 项，${description}`} aria-controls="workspace-inspector">
      <IconAgentTeam size={15} />
      <span>子任务</span>
      <span className="tabular-nums">{completed}/{tasks.length} 已完成</span>
      {failed > 0 && <span className="subagent-progress-error">{failed} 项失败</span>}
      <IconChevronRight size={13} />
    </button>
  );
}
