import type { SwarmRunRecord } from '../types/backend';
import { IconAgentTeam, IconChevronRight } from './Icons';
import { summarizeSwarmRun } from '../utils/swarmCommand';

export function SwarmThreadCard({ run, onOpen }: { run?: SwarmRunRecord; onOpen?: () => void }) {
  const progress = run && summarizeSwarmRun(run);
  const status = progress?.label ?? '等待同步';
  const nodes = progress && progress.total > 0 ? ` · ${progress.completed}/${progress.total} 个节点完成` : '';
  const heading = (
    <>
      <IconAgentTeam size={14} aria-hidden="true" />
      <span className="codex-direct-activity-label">
        <span className="swarm-thread-title">Swarm 协作</span>
        <span className="swarm-thread-status tabular-nums" data-tone={progress?.tone}> · {status}{nodes}</span>
      </span>
      {onOpen && <IconChevronRight size={13} aria-hidden="true" className="codex-direct-chevron" />}
    </>
  );
  const className = 'swarm-thread-card codex-direct-activity-row';
  const running = progress?.tone === 'active';
  return onOpen
    ? <button type="button" className={className} data-running={running} onClick={onOpen}
        title={`查看 Swarm 计划和节点 · ${status}${nodes}`}>{heading}</button>
    : <div className={className} data-running={running}>{heading}</div>;
}
