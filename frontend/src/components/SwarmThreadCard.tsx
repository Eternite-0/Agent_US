import type { SwarmRunRecord } from '../types/backend';
import { IconAgentTeam, IconChevronRight } from './Icons';
import { summarizeSwarmRun } from '../utils/swarmCommand';

export function SwarmThreadCard({ run, onOpen }: { run?: SwarmRunRecord; onOpen?: () => void }) {
  const progress = run && summarizeSwarmRun(run);
  const heading = (
    <>
      <span className="swarm-thread-icon"><IconAgentTeam size={17} aria-hidden="true" /></span>
      <span className="swarm-thread-copy">
        <span className="swarm-thread-title">Swarm 协作</span>
        <span className="swarm-thread-status" data-tone={progress?.tone}>
          <i aria-hidden="true" />{progress?.label ?? '等待同步'}
          {progress && progress.total > 0 && <span> · {progress.completed}/{progress.total} 个节点完成</span>}
        </span>
        {progress && progress.total > 0 && <progress value={progress.completed} max={progress.total} aria-label="Swarm 节点完成进度" />}
      </span>
      {onOpen && <IconChevronRight size={15} aria-hidden="true" className="swarm-thread-chevron" />}
    </>
  );
  return onOpen
    ? <button type="button" className="swarm-thread-card" onClick={onOpen} title="查看 Swarm 计划和节点">{heading}</button>
    : <div className="swarm-thread-card">{heading}</div>;
}
