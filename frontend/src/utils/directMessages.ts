import type { SessionHistoryItem } from '../types/backend';

interface Exchange {
  key: string;
  userText: string;
  command: boolean;
  swarmRunId?: string;
  assistantTexts: Array<{ id: string; text: string; reasoning?: string }>;
  tools: Array<{ id: string; name: string; output?: string; isError?: boolean }>;
}

export function groupDirectMessages(sessionId: string, input: string, items: SessionHistoryItem[]): Exchange[] {
  const exchanges: Exchange[] = [];
  const byTurn = new Map<string, Exchange>();
  function add(key: string, userText: string, command = false): Exchange {
    const exchange: Exchange = { key, userText, command, assistantTexts: [], tools: [] };
    exchanges.push(exchange);
    return exchange;
  }
  for (const item of items) {
    if (item.type === 'user/message') {
      const exchange = add(`${sessionId}-ex-${item.cursor}`, item.text ?? '', Boolean(item.meta?.swarmAction));
      if (exchange.command && typeof item.meta?.runId === 'string') exchange.swarmRunId = item.meta.runId;
      if (item.turnId) byTurn.set(item.turnId, exchange);
      continue;
    }
    // A synchronous command and receipt can arrive while an earlier turn is streaming.
    const exchange = (item.turnId && byTurn.get(item.turnId)) || exchanges.at(-1) || add(`${sessionId}-ex-0`, input);
    if (item.type === 'assistant/message' && (item.text?.trim() || item.reasoning?.trim())) {
      exchange.assistantTexts.push({ id: `${sessionId}-m-${item.cursor}`, text: item.text ?? '', reasoning: item.reasoning });
    } else if (item.type === 'tool/result') {
      exchange.tools.push({ id: item.callId || `${sessionId}-t-${item.cursor}`, name: item.name || 'tool', output: item.text, isError: Boolean(item.meta?.isError) });
    }
  }
  return exchanges;
}
