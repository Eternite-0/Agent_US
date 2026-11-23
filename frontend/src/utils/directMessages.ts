import type { EventEnvelope, SessionHistoryItem } from '../types/backend';

export interface DirectLiveStream {
  turnId?: string;
  text: string;
  reasoning: string;
}

export interface DirectLiveToolOutput {
  turnId?: string;
  callId: string;
  name: string;
  text: string;
}

export interface DirectToolActivity {
  kind: 'tool';
  id: string;
  name: string;
  args?: string | Record<string, unknown>;
  output?: string;
  liveOutput?: string;
  status: 'running' | 'waiting' | 'completed' | 'failed' | 'interrupted';
}

type ActivityItem = DirectToolActivity | { kind: 'reasoning'; id: string; text: string; live?: boolean };
export type DirectTimelineBlock =
  | { kind: 'activity'; id: string; items: ActivityItem[]; waiting?: boolean }
  | { kind: 'message'; id: string; text: string; live?: boolean };

type TurnEnd = 'turn/completed' | 'turn/failed' | 'turn/cancelled' | 'turn/parked';
export const isDirectTurnEnd = (type: string): type is TurnEnd =>
  type === 'turn/completed' || type === 'turn/failed' || type === 'turn/cancelled' || type === 'turn/parked';

export interface DirectTurnTiming {
  startedAt?: number;
  durationMs?: number;
  end?: TurnEnd;
}

interface Exchange {
  key: string;
  userText: string;
  command: boolean;
  swarmRunId?: string;
  turnId?: string;
  timing?: DirectTurnTiming;
  active?: boolean;
  blocks: DirectTimelineBlock[];
}

interface TimelineOptions {
  events?: EventEnvelope[];
  isLive?: boolean;
  liveStream?: DirectLiveStream;
  liveToolOutputs?: DirectLiveToolOutput[];
  pendingCallIds?: Set<string>;
  awaitingApproval?: boolean;
}

export function groupDirectMessages(sessionId: string, input: string, items: SessionHistoryItem[], options: TimelineOptions = {}): Exchange[] {
  const exchanges: Exchange[] = [];
  const byTurn = new Map<string, Exchange>();
  const tools = new Map<string, DirectToolActivity>();
  const timing = new Map<string, DirectTurnTiming>();
  for (const event of options.events ?? []) {
    const { turnId, durationMs } = event.payload ?? {};
    if (typeof turnId !== 'string') continue;
    if (event.type === 'turn/started') {
      timing.set(turnId, { startedAt: event.timestamp });
    } else if (isDirectTurnEnd(event.type)) {
      const startedAt = timing.get(turnId)?.startedAt;
      timing.set(turnId, {
        startedAt,
        end: event.type,
        durationMs: typeof durationMs === 'number' ? durationMs
          : startedAt !== undefined ? Math.max(0, event.timestamp - startedAt) : undefined,
      });
    }
  }

  function add(key: string, userText: string, command = false, turnId?: string): Exchange {
    const exchange: Exchange = { key, userText, command, turnId, blocks: [] };
    exchanges.push(exchange);
    return exchange;
  }

  function activity(exchange: Exchange): Extract<DirectTimelineBlock, { kind: 'activity' }> {
    const tail = exchange.blocks.at(-1);
    if (tail?.kind === 'activity') return tail;
    const block = { kind: 'activity' as const, id: `${tail?.id ?? exchange.key}-activity`, items: [] };
    exchange.blocks.push(block);
    return block;
  }

  function tool(exchange: Exchange, id: string, name: string, args?: DirectToolActivity['args']): DirectToolActivity {
    const key = `${exchange.turnId ?? exchange.key}:${id}`;
    const existing = tools.get(key);
    if (existing) return existing;
    const row: DirectToolActivity = { kind: 'tool', id, name, args, status: 'interrupted' };
    tools.set(key, row);
    activity(exchange).items.push(row);
    return row;
  }

  const lastAssistant = new Map<Exchange, SessionHistoryItem>();
  for (const item of items) {
    if (item.type === 'user/message') {
      const exchange = add(`${sessionId}-ex-${item.cursor}`, item.text ?? '', Boolean(item.meta?.swarmAction), item.turnId);
      if (exchange.command && typeof item.meta?.runId === 'string') exchange.swarmRunId = item.meta.runId;
      if (item.turnId) {
        if (!byTurn.has(item.turnId)) exchange.timing = timing.get(item.turnId);
        byTurn.set(item.turnId, exchange);
      }
      continue;
    }
    // Synchronous commands (e.g. /swarm stop) can arrive while another turn is streaming.
    const exchange = (item.turnId && byTurn.get(item.turnId)) || exchanges.at(-1) || add(`${sessionId}-ex-0`, input, false, item.turnId);
    if (item.type === 'assistant/message') {
      const id = `${sessionId}-m-${item.cursor}`;
      lastAssistant.set(exchange, item);
      if (item.reasoning?.trim()) activity(exchange).items.push({ kind: 'reasoning', id: `${id}-reasoning`, text: item.reasoning });
      if (item.text?.trim()) exchange.blocks.push({ kind: 'message', id, text: item.text });
      for (const call of item.toolCalls ?? []) tool(exchange, call.id, call.name, call.arguments);
    } else if (item.type === 'tool/call') {
      tool(exchange, item.callId || `${sessionId}-t-${item.cursor}`, item.name || 'tool');
    } else if (item.type === 'tool/result') {
      const row = tool(exchange, item.callId || `${sessionId}-t-${item.cursor}`, item.name || 'tool');
      row.output = item.text;
      row.status = item.meta?.isError ? 'failed' : 'completed';
    }
  }

  if (!exchanges.length) add(`${sessionId}-ex-0`, input);

  if (options.isLive) {
    const { liveStream, liveToolOutputs, pendingCallIds, awaitingApproval } = options;
    const activeTurnId = liveStream?.turnId ?? liveToolOutputs?.at(-1)?.turnId;
    const active = activeTurnId
      ? byTurn.get(activeTurnId) ?? exchanges.findLast((exchange) => !exchange.command && !exchange.turnId)
      : exchanges.findLast((exchange) => !exchange.command);
    if (active && !timing.get(active.turnId ?? activeTurnId ?? '')?.end) {
      active.active = true;
      active.timing ??= timing.get(active.turnId ?? activeTurnId ?? '');
      const persisted = lastAssistant.get(active);
      // The REST bundle can pick up the saved message before the stream is cleared.
      const alreadySaved = persisted && (persisted.text ?? '') === liveStream?.text && (persisted.reasoning ?? '') === liveStream.reasoning;
      if (!alreadySaved && liveStream?.reasoning.trim()) {
        activity(active).items.push({ kind: 'reasoning', id: `${active.key}-live-reasoning`, text: liveStream.reasoning, live: true });
      }
      if (!alreadySaved && liveStream?.text.trim()) {
        active.blocks.push({ kind: 'message', id: `${active.key}-live`, text: liveStream.text, live: true });
      } else {
        for (const output of liveToolOutputs ?? []) {
          if (output.turnId && output.turnId !== (active.turnId ?? activeTurnId)) continue;
          const row = tool(active, output.callId, output.name);
          if (row.status === 'interrupted') row.liveOutput = output.text;
        }
        if (!awaitingApproval && (!active.blocks.length || active.blocks.at(-1)?.kind === 'activity')) {
          activity(active).waiting = true;
        }
      }
      for (const exchange of exchanges) {
        if (exchange !== active && (!active.turnId || exchange.turnId !== active.turnId)) continue;
        for (const block of exchange.blocks) {
          if (block.kind !== 'activity') continue;
          for (const row of block.items) {
            if (row.kind === 'tool' && row.status === 'interrupted') {
              row.status = pendingCallIds?.has(row.id) ? 'waiting' : 'running';
            }
          }
        }
      }
    }
  }
  return exchanges;
}

/** A small, current progress label, not a disclosure of the full reasoning transcript. */
export function reasoningHeadline(text: string): string {
  const line = text.trim().split(/\n+/).reverse().map((part) =>
    part.trim().replace(/^(?:#{1,6}\s+|[-*>]\s+|\d+[.)]\s+)+/, '').replace(/\*\*|__|`/g, '').trim(),
  ).find(Boolean) ?? '';
  const chars = Array.from(line);
  if (chars.length <= 76) return line;
  // For models that stream one long paragraph, keep the current thought in view.
  const tail = chars.slice(-74).join('');
  const boundary = tail.search(/[。！？；]|[.!?;]\s/);
  return boundary >= 0 && boundary < tail.length / 2
    ? tail.slice(boundary + 1).trimStart()
    : `…${tail}`;
}
