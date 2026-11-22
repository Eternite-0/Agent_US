import type { Worker } from '../types/backend';
import { subagentGroups } from '../utils/subagentProgress';
import { IconAgent, IconChevronRight } from './Icons';

export function SubagentProgress({ workers, onOpen }: { workers: Worker[]; onOpen: () => void }) {
  const groups = subagentGroups(workers);
  if (!groups.length) return null;
  const summary = groups.map(({ label, members }) => `${members.length} ${label}`).join(' · ');
  return (
    <button type="button" className="subagent-progress" onClick={onOpen}
      title={`查看子任务进度 · ${summary}`} aria-controls="workspace-inspector">
      <IconAgent size={15} />
      <span>子任务</span>
      <span className="subagent-progress-counts">{summary}</span>
      <IconChevronRight size={13} />
    </button>
  );
}
