import {
  compactTwoStage,
  excerpt,
  measureRequestComposition,
} from './context.js';
import { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm';
import { bundle } from './bundle.js';
import { Fault } from './store.js';
import { buildRepairNote, decideRepair } from './verifier.js';

// A fresh Cordis scope exposes exactly this attempt's tools and adapter.
export async function runSession({
  store,
  task,
  session,
  model,
  adapter,
  persona,
  input,
  workspace,
  tools = [],
  signal,
  maxSteps = 8,
  onUsage,
  onTelemetry,
  summarize = null,
  verify = null,
  repairPolicy = decideRepair,
  stopCheck = null,
}) {
  const ctx = await bundle(store, persona);
  let agent;
  let calls = 0;
  class Metered extends LlmAdapter {
    resolveModel(...args) {
      return adapter.resolveModel(...args);
    }
    async *stream(options) {
      if (++calls > maxSteps) throw new Fault('STEP_BUDGET');
      const started = Date.now();
      const compacted = await compactTwoStage(options, {
        contextWindow: Math.min(200000, model.context),
        summarize,
      });
      const composition = measureRequestComposition(compacted.options);
      try {
        for await (const chunk of adapter.stream(compacted.options)) {
          if (chunk.type === 'usage') onUsage?.(chunk.usage);
          yield chunk;
        }
      } finally {
        onTelemetry?.({
          step: calls,
          compactionStage: compacted.stage,
          composition,
          modelDurationMs: Date.now() - started,
        });
      }
    }
  }
  const abort = () => agent?.cancel({ kind: 'user' });
  try {
    ctx.on('session/event', (s, e) => {
      if (s.id !== session.id) return;
      let text;
      if (e.type === 'user/message')
        text = e.data.content
          ?.filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join('\n');
      if (e.type === 'assistant/message')
        text = e.data.message.content
          .filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join('\n');
      if (
        [
          'user/message',
          'assistant/message',
          'tool/call',
          'tool/result',
          'turn/start',
          'turn/end',
          'step/start',
        ].includes(e.type)
      )
        store.add(
          'history',
          {
            sessionId: s.id,
            type: e.type,
            sequence: e.seq,
            ...(text ? { text: excerpt(text, 16000) } : {}),
            ...(e.type === 'tool/call'
              ? { name: e.data.name, callId: e.data.callId }
              : {}),
          },
          task.projectId,
          task.id,
        );
    });
    await ctx.plugin({
      name: 'agent-us-worker-tools',
      inject: ['tools', 'llm'],
      apply(scoped) {
        scoped.llm.registerAdapter([model.provider], new Metered());
        for (const tool of tools) scoped.tools.register(tool);
      },
    });
    agent = await ctx.agentLoop.create(
      session.id,
      { provider: model.provider, model: model.model, maxTokens: 4096 },
      { cwd: workspace },
    );
    signal.addEventListener('abort', abort, { once: true });
    signal.throwIfAborted();
    agent.followup(
      createUserMessage({
        content: [{ type: 'text', text: input }],
        source: { kind: 'user' },
      }),
    );
    await agent.whenIdle();
    signal.throwIfAborted();

    const extractOutcome = () => {
      const events = agent.session.snapshotEvents();
      const end = events.findLast((e) => e.type === 'turn/end');
      const lastIdx = events.findLastIndex((e) => e.type === 'assistant/message');
      const last = lastIdx >= 0 ? events[lastIdx] : undefined;
      const text = last?.data.message.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('');
      const hasToolsInLastReply =
        lastIdx >= 0 &&
        events.slice(lastIdx + 1).some((e) => e.type === 'tool/call');
      return { events, end, last, text, hasToolsInLastReply };
    };

    let outcome = extractOutcome();
    let continuedOnce = false;
    let repairRound = 0;

    // 1. Optional System-1 premature-stop check (max 1 continuation per session).
    if (
      stopCheck &&
      !continuedOnce &&
      outcome.text &&
      outcome.end?.data.reason.kind === 'completed' &&
      !outcome.last?.data.interrupted &&
      !outcome.hasToolsInLastReply &&
      calls < maxSteps
    ) {
      const check = await stopCheck({
        requestText: input,
        replyText: outcome.text,
        hasTools: outcome.hasToolsInLastReply,
        alreadyContinued: continuedOnce,
      });
      if (check?.shouldContinue && check.note) {
        continuedOnce = true;
        store.event('judgment.stop_continued', task.projectId, task.id, {
          sessionId: session.id,
          prob: check.prob,
          cached: !!check.cached,
        });
        agent.followup(
          createUserMessage({
            content: [{ type: 'text', text: check.note }],
            source: { kind: 'user' },
          }),
        );
        await agent.whenIdle();
        signal.throwIfAborted();
        outcome = extractOutcome();
      }
    }

    // 2. Deterministic T0 completion verifier + bounded 1-round warm repair.
    if (
      verify &&
      outcome.text &&
      outcome.end?.data.reason.kind === 'completed' &&
      !outcome.last?.data.interrupted
    ) {
      const verdict = verify({ events: outcome.events, text: outcome.text });
      if (verdict && verdict.verdict !== 'pass') {
        store.event('verifier.signal', task.projectId, task.id, {
          sessionId: session.id,
          verdict: verdict.verdict,
          reasons: verdict.reasons,
        });
        const decision = repairPolicy({ round: ++repairRound, verdict });
        if (decision === 'repair' && calls < maxSteps) {
          store.event('verifier.repair', task.projectId, task.id, {
            sessionId: session.id,
            round: repairRound,
            reasons: verdict.reasons,
          });
          agent.followup(
            createUserMessage({
              content: [{ type: 'text', text: buildRepairNote(verdict) }],
              source: { kind: 'user' },
            }),
          );
          await agent.whenIdle();
          signal.throwIfAborted();
          outcome = extractOutcome();
        }
      }
    }

    const { events, end, last, text } = outcome;
    if (
      !text ||
      end?.data.reason.kind !== 'completed' ||
      last.data.interrupted ||
      events.at(-1)?.type === 'assistant/attempt'
    )
      throw new Fault('MODEL_DID_NOT_FINISH');
    return text;
  } finally {
    signal.removeEventListener('abort', abort);
    await ctx.fiber.dispose();
  }
}
