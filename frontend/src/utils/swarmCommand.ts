import { parseSwarmCommand } from '../../../backend/src/swarm/command.js';

export function isSwarmCommand(text: string): boolean {
  return parseSwarmCommand(text) !== null;
}

export function swarmAttachmentError(text: string, files?: Record<string, string>): string | undefined {
  if (files && Object.keys(files).length && isSwarmCommand(text)) {
    return '/swarm 命令不支持上传附件。请移除附件后发送，或改发普通消息。';
  }
}
