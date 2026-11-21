import { rmSync } from 'node:fs';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';

export function rmDirSafe(dir) {
  if (!dir) return;
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
  } catch (err) {
    // Ignore transient Windows Defender / SQLite handle locks during teardown
    // after retries are exhausted on already-closed temp directories.
    if (
      err &&
      (err.code === 'EBUSY' ||
        err.code === 'EPERM' ||
        err.code === 'ENOTEMPTY' ||
        err.code === 'ENOENT')
    ) {
      return;
    }
    throw err;
  }
}

export function withTimeout(promise, ms = 20000, label = 'async barrier') {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Timed out after ${ms}ms waiting for ${label}`));
    }, ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    clearTimeout(timer);
  });
}

export const model = {
  provider: 'fixture',
  model: 'test',
  tools: true,
  context: 65536,
  speed: 1,
  design: 1,
  coding: 1,
  math: 1,
  research: 1,
  inputRate: 0,
  outputRate: 0,
};
export class Script extends LlmAdapter {
  constructor(reply) {
    super();
    this.reply = reply;
  }
  async *stream(opts) {
    const answer = await this.reply(opts);
    const block =
      typeof answer === 'string' ? { type: 'text', text: answer } : answer;
    yield { type: 'block-start', index: 0, blockType: block.type };
    yield block.type === 'text'
      ? { type: 'text-delta', index: 0, text: block.text }
      : {
          type: 'tool-call-delta',
          index: 0,
          id: block.id,
          name: block.name,
          argumentsDelta: block.arguments,
        };
    yield { type: 'block-end', index: 0, block };
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 8 } };
    yield {
      type: 'finish',
      reason: { kind: block.type === 'text' ? 'stop' : 'tool-calls' },
    };
  }
}
