import type { EventEnvelope, SessionHistoryItem } from '../types/backend';

export interface DirectLiveStream {
  turnId?: string;
  afterAssistantCursor?: number;
  settled?: boolean;
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
  callId: string;
  name: string;
  args?: string | Record<string, unknown>;
  output?: string;
  liveOutput?: string;
  status: 'running' | 'waiting' | 'completed' | 'failed' | 'interrupted';
  durationMs?: number;
  exitCode?: number;
}

type ActivityItem = DirectToolActivity | { kind: 'reasoning'; id: string; text: string; live?: boolean };
export type DirectTimelineBlock =
  | { kind: 'activity'; id: string; items: ActivityItem[]; waiting?: boolean }
  | { kind: 'message'; id: string; text: string; live?: boolean; justArrived?: boolean };

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
  recentEvents?: readonly EventEnvelope[];
}

export function groupDirectMessages(sessionId: string, input: string, items: SessionHistoryItem[], options: TimelineOptions = {}): Exchange[] {
  const historyTail = items.at(-1)?.cursor ?? 0;
  const snapshotSeq = options.events?.at(-1)?.seq ?? 0;
  const events = options.recentEvents?.some((ev) => ev.seq > snapshotSeq)
    ? [...(options.events ?? []), ...options.recentEvents.filter((ev) => ev.seq > snapshotSeq)]
    : options.events ?? [];
  // The final SSE carries the persisted message cursor. Treat it as a history
  // row until REST catches up, preserving the same step key and React subtree.
  // Never resurrect messages that were deliberately removed by a rewind.
  const rewoundAt = events.findLast((ev) => ev.type === 'session/rewound' && Number(ev.payload?.removedMessages) > 0)?.seq ?? 0;
  const pendingMessages: SessionHistoryItem[] = [];
  const justArrived = new Set<number>();
  const snapshotCursors = new Set(items.map((item) => item.cursor));
  for (const event of events) {
    if (event.type !== 'assistant/message' || event.seq <= rewoundAt) continue;
    const { turnId, messageCursor, text, reasoning, toolCalls } = event.payload ?? {};
    if (typeof turnId !== 'string' || typeof messageCursor !== 'number' || !Number.isSafeInteger(messageCursor) || messageCursor <= historyTail) continue;
    if (snapshotCursors.has(messageCursor)) continue;
    snapshotCursors.add(messageCursor);
    if (event.seq > snapshotSeq) justArrived.add(messageCursor);
    pendingMessages.push({
      cursor: messageCursor, sequence: messageCursor, sessionId, turnId, type: 'assistant/message',
      text: typeof text === 'string' ? text : '', reasoning: typeof reasoning === 'string' ? reasoning : undefined,
      toolCalls: Array.isArray(toolCalls) ? toolCalls : undefined,
    });
  }
  if (pendingMessages.length) items = [...items, ...pendingMessages.sort((a, b) => a.cursor - b.cursor)];
  const exchanges: Exchange[] = [];
  const byTurn = new Map<string, Exchange>();
  const tools = new Map<string, DirectToolActivity>();
  const timing = new Map<string, DirectTurnTiming>();
  let latestStartedTurn: string | undefined;
  let latestStartedAt = -Infinity;
  const turnEvents = events.filter((event) => event.type === 'turn/started' || isDirectTurnEnd(event.type))
    .sort((a, b) => a.timestamp - b.timestamp || (a.seq ?? 0) - (b.seq ?? 0));
  for (const event of turnEvents) {
    const { turnId, durationMs } = event.payload ?? {};
    if (typeof turnId !== 'string') continue;
    if (event.type === 'turn/started') {
      timing.set(turnId, { startedAt: event.timestamp });
      if (event.timestamp >= latestStartedAt) {
        latestStartedTurn = turnId;
        latestStartedAt = event.timestamp;
      }
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

  const id = (...parts: Array<string | number>) => JSON.stringify([sessionId, ...parts]);
  const turnKey = (turnId: string) => id('turn', turnId);
  const liveTurnCandidates = [options.liveStream?.turnId, ...[...(options.liveToolOutputs ?? [])].reverse().map((row) => row.turnId)];
  const activeTurnId = liveTurnCandidates.find((turnId) => turnId && !timing.get(turnId)?.end) ?? latestStartedTurn ?? liveTurnCandidates[0];
  const historyTurns = new Set(items.flatMap((item) => item.turnId && item.type === 'user/message' && !item.meta?.swarmAction ? [item.turnId] : []));
  const turnScope = (exchange: Exchange) => exchange.turnId ? turnKey(exchange.turnId) : exchange.key;

  function add(key: string, userText: string, command = false, turnId?: string): Exchange {
    const exchange: Exchange = { key, userText, command, turnId, blocks: [] };
    exchanges.push(exchange);
    if (turnId && !command) {
      if (!byTurn.has(turnId)) exchange.timing = timing.get(turnId);
      byTurn.set(turnId, exchange);
    }
    return exchange;
  }

  function phase(exchange: Exchange): Extract<DirectTimelineBlock, { kind: 'activity' }> {
    const tail = exchange.blocks.at(-1);
    if (tail?.kind === 'activity') return tail;
    const block = { kind: 'activity' as const, id: id('phase', tail?.id ?? exchange.key), items: [] };
    exchange.blocks.push(block);
    return block;
  }

  function tool(exchange: Exchange, callId: string, name?: string, args?: DirectToolActivity['args']): DirectToolActivity {
    const key = id('tool', turnScope(exchange), callId);
    const existing = tools.get(key);
    if (existing) {
      if (name && existing.name === 'tool') existing.name = name;
      if (args !== undefined && existing.args === undefined) existing.args = args;
      return existing;
    }
    const row: DirectToolActivity = { kind: 'tool', id: key, callId, name: name || 'tool', args, status: 'interrupted' };
    tools.set(key, row);
    phase(exchange).items.push(row);
    return row;
  }

  // A live model step and the history row that replaces it share the same predecessor.
  // Cursors are session-wide sequence numbers, so user steering and tool rows may occupy
  // the intervening cursors; predicting the new assistant cursor would be incorrect.
  const lastAssistant = new Map<string, SessionHistoryItem>();
  const stepId = (exchange: Exchange) => id('step', turnScope(exchange), lastAssistant.get(turnScope(exchange))?.cursor ?? 'first');
  const seenCursors = new Set<number>();
  for (const item of items) {
    if (seenCursors.has(item.cursor)) continue;
    seenCursors.add(item.cursor);
    if (item.type === 'user/message') {
      const command = Boolean(item.meta?.swarmAction);
      const turnId = command ? undefined : item.turnId;
      const existing = turnId ? byTurn.get(turnId) : undefined;
      if (existing && !item.meta?.steering && !existing.userText) {
        existing.userText = item.text ?? '';
        continue;
      }
      const key = turnId && !existing ? turnKey(turnId) : id(command ? 'command' : 'user', item.cursor);
      const exchange = add(key, item.text ?? '', command, turnId);
      if (command && typeof item.meta?.runId === 'string') exchange.swarmRunId = item.meta.runId;
      continue;
    }
    if (item.type !== 'assistant/message' && item.type !== 'tool/call' && item.type !== 'tool/result') continue;
    // Commands are independent even when their acknowledgement lands inside a running turn.
    // Older receipts may omit metadata on the acknowledgement itself.
    const last = exchanges.at(-1);
    const legacyAck = item.type === 'assistant/message' && last?.command && last.blocks.length === 0 ? last : undefined;
    const exchange = item.turnId
      ? byTurn.get(item.turnId) ?? add(turnKey(item.turnId), historyTurns.has(item.turnId) ? '' : input, false, item.turnId)
      : (item.meta?.swarmAction ? exchanges.findLast((ex) => ex.command && ex.swarmRunId === item.meta?.runId)
        : legacyAck ?? exchanges.findLast((ex) => !ex.command)) ?? add(id('fallback'), input);
    if (item.type === 'assistant/message') {
      const key = stepId(exchange);
      lastAssistant.set(turnScope(exchange), item);
      if (item.reasoning?.trim()) phase(exchange).items.push({ kind: 'reasoning', id: id('reasoning', key), text: item.reasoning });
      if (item.text?.trim()) exchange.blocks.push({ kind: 'message', id: key, text: item.text, justArrived: justArrived.has(item.cursor) });
      for (const call of item.toolCalls ?? []) tool(exchange, call.id, call.name, call.arguments);
    } else {
      const row = tool(exchange, item.callId || id('history-call', item.cursor), item.name);
      if (item.type === 'tool/result') {
        row.output = item.text;
        row.status = item.meta?.isError ? 'failed' : 'completed';
        if (typeof item.meta?.durationMs === 'number') row.durationMs = item.meta.durationMs;
        if (typeof item.meta?.exitCode === 'number') row.exitCode = item.meta.exitCode;
      }
    }
  }

  let active: Exchange | undefined;
  if (options.isLive) {
    const lastChat = exchanges.findLast((exchange) => !exchange.command);
    const turnId = activeTurnId && timing.get(activeTurnId)?.end && lastChat?.turnId && !timing.get(lastChat.turnId)?.end
      ? lastChat.turnId : activeTurnId;
    active = turnId ? byTurn.get(turnId) : lastChat;
    if (!active && (!turnId || !timing.get(turnId)?.end)) {
      active = add(turnId ? turnKey(turnId) : id('fallback'), input, false, turnId);
    }
    if (active && (active.timing?.end || timing.get(active.turnId ?? '')?.end)) active = undefined;
    if (active) {
      active.active = true;
      active.timing ??= timing.get(active.turnId ?? '');
    }
  }

  const live = options.liveStream;
  const streamedExchange = live?.settled && live.turnId ? byTurn.get(live.turnId) : active;
  if (live && streamedExchange && (!live.turnId || live.turnId === streamedExchange.turnId)) {
    const persisted = lastAssistant.get(turnScope(streamedExchange));
    const alreadySaved = persisted && (live.afterAssistantCursor !== undefined
      ? persisted.cursor > live.afterAssistantCursor
      : (persisted.text ?? '') === live.text && (persisted.reasoning ?? '') === live.reasoning);
    if (!alreadySaved) {
      const key = stepId(streamedExchange);
      if (live.reasoning.trim()) phase(streamedExchange).items.push({ kind: 'reasoning', id: id('reasoning', key), text: live.reasoning, live: !live.settled });
      if (live.text.trim()) streamedExchange.blocks.push({ kind: 'message', id: key, text: live.text, live: !live.settled });
    }
  }

  // Runtime events can reach the UI before the next REST history fetch. Enrich an existing
  // call in place, or use the same call identity for a temporary row until its history lands.
  for (const event of events) {
    if (event.type !== 'tool/call' && event.type !== 'tool/result') continue;
    const { turnId, callId, name, arguments: args, output, isError, durationMs } = event.payload ?? {};
    if (typeof turnId !== 'string' || typeof callId !== 'string' || !callId) continue;
    const exchange = byTurn.get(turnId);
    if (!exchange) continue;
    if (exchange !== active && !tools.has(id('tool', turnKey(turnId), callId)) && !(event.seq > Math.max(snapshotSeq, rewoundAt))) continue;
    const row = tool(exchange, callId, typeof name === 'string' ? name : undefined,
      typeof args === 'string' || (args && typeof args === 'object' && !Array.isArray(args)) ? args as DirectToolActivity['args'] : undefined);
    if (event.type === 'tool/result' && row.status === 'interrupted') {
      row.status = isError ? 'failed' : 'completed';
      const buffered = options.liveToolOutputs?.find((entry) => entry.turnId === turnId && entry.callId === callId)?.text;
      if (typeof output === 'string') row.output = buffered && output.length < buffered.length ? buffered : output;
      else if (buffered) row.output = buffered;
      if (typeof durationMs === 'number') row.durationMs = durationMs;
    }
  }

  // Receipt facts take priority over the shell output's display-only exit prefix.
  for (const event of events) {
    if (event.type !== 'tool/receipt') continue;
    const { turnId, callId, exitCode } = event.payload ?? {};
    if (typeof turnId !== 'string' || typeof callId !== 'string' || typeof exitCode !== 'number') continue;
    const row = tools.get(id('tool', turnKey(turnId), callId));
    if (row && row.exitCode === undefined) row.exitCode = exitCode;
  }

  if (active) {
    for (const output of options.liveToolOutputs ?? []) {
      if (!output.callId || (output.turnId && output.turnId !== active.turnId)) continue;
      const row = tool(active, output.callId, output.name);
      if (row.status === 'interrupted') row.liveOutput = output.text;
    }
    for (const exchange of exchanges) {
      if (turnScope(exchange) !== turnScope(active)) continue;
      for (const block of exchange.blocks) {
        if (block.kind !== 'activity') continue;
        for (const row of block.items) {
          if (row.kind === 'tool' && row.status === 'interrupted') {
            row.status = options.pendingCallIds?.has(row.callId) ? 'waiting' : 'running';
          }
        }
      }
    }
    if (!options.awaitingApproval && (!active.blocks.length || active.blocks.at(-1)?.kind === 'activity')) {
      phase(active).waiting = true;
    }
  }
  if (!exchanges.length) add(id('fallback'), input);
  return exchanges;
}

/** Remove the runtime's display-only framing, keeping stdout/stderr as plain text. */
export function directToolOutput(row: Pick<DirectToolActivity, 'name' | 'output' | 'exitCode'>): { output?: string; exitCode?: number } {
  let { output, exitCode } = row;
  if (output === undefined) return { output, exitCode };

  const frame = /^((?:\[[A-Z][A-Z0-9_]*\][^\r\n]*\r?\n)?)<untrusted id="([0-9a-f]{32,64}-tool-[A-Za-z0-9_.:-]+)" bytes="\d+">/.exec(output);
  const closeTag = frame && `</untrusted id="${frame[2]}">`;
  const framed = frame && closeTag && output.endsWith(closeTag);
  let body = framed ? output.slice(frame[0].length, -closeTag.length) : output;
  if (row.name === 'bash') {
    // Only the bash result protocol has this first-line field; never read it from
    // live output, arbitrary tools, or from inside stdout/stderr.
    const prefix = /^exitCode: (-?\d+)(?:\r?\n(?=(?:stdout|stderr):\r?\n)|$)/.exec(body);
    if (prefix) {
      const value = Number(prefix[1]);
      if (Number.isSafeInteger(value)) exitCode ??= value;
      body = body.slice(prefix[0].length);
    }
  }
  output = (framed ? frame[1] : '') + body;
  return { output, exitCode };
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
