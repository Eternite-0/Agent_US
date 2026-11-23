import { parseSwarmCommand } from '../../../backend/src/swarm/command.js';

export function isSwarmCommand(text: string): boolean {
  return parseSwarmCommand(text) !== null;
}

export function swarmAttachmentError(text: string, files?: Record<string, string>): string | undefined {
  if (files && Object.keys(files).length && isSwarmCommand(text)) {
    return '/swarm 命令不支持上传附件。请移除附件后发送，或改发普通消息。';
  }
}

export function summarizeSwarmRun(run: { status: string; nodes?: Array<{ status: string }> }) {
  const labels: Record<string, string> = {
    pending: '等待规划', queued: '排队中', planning: '正在制定计划', running: '协作执行中',
    verifying: '正在验收', aggregating: '正在汇总', reconciling: '等待核对',
    parked: '已暂停', interrupted: '已中断', completed: '已完成', failed: '执行失败', cancelled: '已取消',
  };
  const nodes = (run.nodes ?? []).filter(({ status }) => status !== 'superseded');
  const tone = run.status === 'completed' ? 'done' : run.status === 'failed' ? 'error'
    : ['cancelled', 'parked', 'interrupted'].includes(run.status) ? 'idle' : 'active';
  return { label: labels[run.status] ?? '同步中', tone, completed: nodes.filter(({ status }) => status === 'completed').length, total: nodes.length };
}
