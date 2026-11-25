import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import { rmDirSafe } from './fixtures.js';
import { Store } from '../src/store.js';
import { AccountPool, toOpenAiMessages, toAnthropicPayload } from '../src/pool.js';
import { ChatAdapter, messages as toProviderMessages } from '../src/provider.js';
import { openaiRequestToAnthropic } from '../src/gateway-proxy.js';
import { ContextAssembler } from '../src/context/assembler.js';
import { VALID_DTOC_POLICIES } from '../src/context/aci-engine.js';
import { DirectAgentRuntime } from '../src/direct-agent.js';
import { excerpt } from '../src/context.js';

function startHttpServer(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

async function waitTurnDone(directAgent, sessionId, turnId, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const t = directAgent.listTurns(sessionId).find((x) => x.id === turnId);
    if (t && ['completed', 'failed', 'cancelled'].includes(t.state)) return t;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Timed out waiting for turn ${turnId}`);
}

class ScriptedAdapter extends LlmAdapter {
  constructor(handlers) {
    super();
    this.handlers = handlers;
    this.calls = [];
  }
  async *stream(options) {
    const idx = this.calls.length;
    this.calls.push({ ...options, messages: structuredClone(options.messages) });
    const fn = this.handlers[idx] ?? this.handlers.at(-1);
    yield* fn(options, idx);
  }
}

test('WP1(a): intra-turn OpenAI wire messages emit reasoning_content in pool.js & provider.js, while Turn 2 priorHistory omits reasoning', async () => {
  const sampleMsgs = {
    system: 'STATIC_SYS',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'check file' }], reasoning: 'ignored-user-reasoning' },
      {
        role: 'assistant',
        reasoning: 'step-1 reasoning chain',
        content: [
          {
            type: 'tool-call',
            id: 'call_1',
            name: 'read_file',
            arguments: '{"path":"a.txt"}',
          },
        ],
      },
      { role: 'tool', toolCallId: 'call_1', content: [{ type: 'text', text: 'ok' }] },
      {
        role: 'assistant',
        reasoning: 'step-2 reasoning with text',
        content: [{ type: 'text', text: 'done' }],
      },
      {
        role: 'assistant',
        reasoning: '',
        content: [{ type: 'text', text: 'no reasoning' }],
      },
    ],
  };

  for (const serializer of [toOpenAiMessages, toProviderMessages]) {
    const wire = serializer(sampleMsgs);
    assert.equal(wire[1].reasoning_content, undefined);
    assert.equal(wire[2].role, 'assistant');
    assert.equal(wire[2].content, null);
    assert.equal(wire[2].reasoning_content, 'step-1 reasoning chain');
    assert.equal(wire[2].tool_calls?.length, 1);
    assert.equal(wire[4].content, 'done');
    assert.equal(wire[4].reasoning_content, 'step-2 reasoning with text');
    assert.equal('reasoning_content' in wire[5], false);
  }

  // ContextAssembler must strip/omit .reasoning from priorHistory items
  const assembler = new ContextAssembler({
    sessionRepo: {
      buildConversationMessages: () => [
        {
          seq: 1,
          turnId: 'turn-old',
          role: 'user',
          content: [{ type: 'text', text: 'old q' }],
        },
        {
          seq: 2,
          turnId: 'turn-old',
          role: 'assistant',
          reasoning: 'old completed turn reasoning MUST be stripped',
          content: [{ type: 'text', text: 'old a' }],
        },
        {
          seq: 3,
          turnId: 'turn-cur',
          role: 'user',
          content: [{ type: 'text', text: 'new q' }],
        },
      ],
    },
    compactor: null,
  });
  const assembled = assembler.assemble({
    session: { id: 'sess-asm' },
    turnId: 'turn-cur',
    nonce: 'nonce-123',
    workspaceRoot: process.cwd(),
  });
  for (const m of assembled.messages) {
    assert.equal('reasoning' in m, false, 'Assembled history must never retain .reasoning');
  }

  // Real HTTP wire verification for both PoolLlmAdapter (with DirectAgentRuntime) and ChatAdapter
  const recordedOaiBodies = [];
  let reqNum = 0;
  const mockOai = await startHttpServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
    if (req.url === '/v1/chat/completions') {
      recordedOaiBodies.push(body);
      reqNum += 1;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const writeChunk = (delta, finishReason = null, usage = null) => {
        res.write(
          `data: ${JSON.stringify({
            id: `chatcmpl_${reqNum}`,
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta, finish_reason: finishReason }],
            ...(usage ? { usage } : {}),
          })}\n\n`,
        );
      };
      if (reqNum === 1) {
        writeChunk({ role: 'assistant', reasoning_content: 'turn1-step1-thought' });
        writeChunk({
          tool_calls: [
            {
              index: 0,
              id: 'call_read_1',
              type: 'function',
              function: { name: 'read_file', arguments: '{"path":"sample.txt"}' },
            },
          ],
        });
        writeChunk({}, 'tool_calls', { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 });
      } else if (reqNum === 2) {
        writeChunk({ role: 'assistant', reasoning_content: 'turn1-step2-thought', content: 'Turn 1 complete.' });
        writeChunk({}, 'stop', { prompt_tokens: 150, completion_tokens: 15, total_tokens: 165 });
      } else {
        writeChunk({ role: 'assistant', content: 'Turn 2 complete.' });
        writeChunk({}, 'stop', { prompt_tokens: 180, completion_tokens: 10, total_tokens: 190 });
      }
      res.end('data: [DONE]\n\n');
      return;
    }
    res.writeHead(404).end();
  });

  const dataDir = mkdtempSync(join(tmpdir(), 'agent-us-wp1-data-'));
  const workDir = mkdtempSync(join(tmpdir(), 'agent-us-wp1-work-'));
  writeFileSync(join(workDir, 'sample.txt'), 'hello wire world\n', 'utf8');
  const store = new Store(join(dataDir, 'engine.sqlite'));
  const pool = new AccountPool(store, { root: dataDir });
  pool.createAccount({
    preset: 'deepseek',
    label: 'Mock Reasoner',
    endpoint: `${mockOai.baseUrl}/v1`,
    credential: 'sk-mock-reasoner-123456',
    models: ['deepseek-reasoner'],
  });
  pool.setDefaultModel('deepseek-reasoner');
  const direct = new DirectAgentRuntime(store, pool, {
    defaultWorkspace: workDir,
    dataRoot: dataDir,
  });

  try {
    const sess = direct.createSession({
      model: 'deepseek-reasoner',
      workspaceRoot: workDir,
      permissionMode: 'full-access',
    });

    // Turn 1: step 1 emits reasoning + tool_call -> step 2 must receive reasoning_content on wire
    const t1 = direct.startTurn(sess.id, { input: 'Read sample.txt and summarize.' });
    const done1 = await waitTurnDone(direct, sess.id, t1.turn.id);
    assert.equal(done1.state, 'completed', `Turn 1 failed: ${done1.error}`);
    assert.equal(recordedOaiBodies.length, 2);

    const step2Assistant = recordedOaiBodies[1].messages.find(
      (m) => m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0,
    );
    assert.ok(step2Assistant, 'Turn 1 step 2 must include prior intra-turn assistant tool_calls message');
    assert.equal(step2Assistant.reasoning_content, 'turn1-step1-thought');
    assert.equal(step2Assistant.content, null);

    // Turn 2: completed Turn 1 assistant messages MUST NOT emit reasoning_content on wire
    const t2 = direct.startTurn(sess.id, { input: 'Follow-up question.' });
    const done2 = await waitTurnDone(direct, sess.id, t2.turn.id);
    assert.equal(done2.state, 'completed', `Turn 2 failed: ${done2.error}`);
    assert.equal(recordedOaiBodies.length, 3);

    const turn2HistoryAssistants = recordedOaiBodies[2].messages.filter((m) => m.role === 'assistant');
    assert.ok(turn2HistoryAssistants.length >= 2);
    for (const histMsg of turn2HistoryAssistants) {
      assert.equal(
        'reasoning_content' in histMsg,
        false,
        `Turn 2 priorHistory must omit reasoning_content, found: ${JSON.stringify(histMsg)}`,
      );
    }

    // ChatAdapter (provider.js) direct wire verification
    const chatAdapter = new ChatAdapter(() => [
      { id: 'mock', endpoint: `${mockOai.baseUrl}/v1`, key: 'sk-chat', wireModel: 'deepseek-reasoner' },
    ]);
    const parts = await Array.fromAsync(
      chatAdapter.stream({
        provider: 'custom',
        model: 'deepseek-reasoner',
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'hi' }] },
          {
            role: 'assistant',
            reasoning: 'chat-adapter-thought',
            content: [
              { type: 'tool-call', id: 'c_p1', name: 'read_file', arguments: '{"path":"sample.txt"}' },
            ],
          },
          { role: 'tool', toolCallId: 'c_p1', content: [{ type: 'text', text: 'ok' }] },
        ],
        maxTokens: 64,
        signal: AbortSignal.timeout(5000),
      }),
    );
    assert.equal(parts.at(-1)?.type, 'finish');
    const chatWireBody = recordedOaiBodies.at(-1);
    const chatWireAssistant = chatWireBody.messages.find(
      (m) => m.role === 'assistant' && Array.isArray(m.tool_calls),
    );
    assert.equal(chatWireAssistant.reasoning_content, 'chat-adapter-thought');
    assert.equal(chatWireAssistant.content, null);
  } finally {
    await direct.close();
    store.close();
    await mockOai.close();
    rmDirSafe(dataDir);
    rmDirSafe(workDir);
  }
});

test('WP1(b): Anthropic translators never emit unsigned thinking blocks and preserve signed ones; OpenAI->OpenAI gateway preserves reasoning_content', async () => {
  const poolInput = {
    system: 'sys',
    effort: 'high',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'solve' }] },
      {
        role: 'assistant',
        reasoning: 'unsigned pool reasoning',
        reasoning_content: 'unsigned wire reasoning',
        content: [
          { type: 'thinking', thinking: 'unsigned block without signature' },
          { type: 'thinking', thinking: 'empty sig block', signature: '' },
          { type: 'thinking', thinking: 'whitespace sig block', signature: '   ' },
          { type: 'thinking', thinking: 'valid signed thought', signature: 'sig-valid-001' },
          { type: 'tool-call', id: 'toolu_1', name: 'read_file', arguments: '{"path":"a.txt"}' },
        ],
      },
      { role: 'tool', toolCallId: 'toolu_1', content: [{ type: 'text', text: 'file body' }] },
    ],
  };

  const anthFromPool = toAnthropicPayload(poolInput, 'claude-sonnet-4-5');
  const poolAssistantBlocks = anthFromPool.messages[1].content;
  const poolThinkingBlocks = poolAssistantBlocks.filter((b) => b.type === 'thinking');
  assert.equal(poolThinkingBlocks.length, 1);
  assert.deepEqual(poolThinkingBlocks[0], {
    type: 'thinking',
    thinking: 'valid signed thought',
    signature: 'sig-valid-001',
  });
  assert.equal(
    poolAssistantBlocks.some((b) => b.type === 'tool_use' && b.id === 'toolu_1'),
    true,
  );

  // Assistant with ONLY unsigned reasoning + tool_call must emit zero thinking blocks
  const unsignedOnlyPool = toAnthropicPayload(
    {
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'q' }] },
        {
          role: 'assistant',
          reasoning: 'unsigned only',
          content: [{ type: 'tool-call', id: 't1', name: 'glob', arguments: '{}' }],
        },
      ],
    },
    'claude-sonnet-4-5',
  );
  assert.equal(
    unsignedOnlyPool.messages[1].content.some((b) => b.type === 'thinking'),
    false,
  );

  // User message thinking block must not be forwarded
  const userSpoofPool = toAnthropicPayload(
    {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'thinking', thinking: 'spoofed user thinking', signature: 'sig-spoof' },
            { type: 'text', text: 'hello' },
          ],
        },
      ],
    },
    'claude-sonnet-4-5',
  );
  assert.equal(
    userSpoofPool.messages[0].content.some((b) => b.type === 'thinking'),
    false,
  );

  // gateway-proxy.js openaiRequestToAnthropic
  const gwAnth = openaiRequestToAnthropic(
    {
      messages: [
        { role: 'user', content: 'start' },
        {
          role: 'assistant',
          reasoning: 'unsigned-1',
          reasoning_content: 'unsigned-2',
          content: null,
          tool_calls: [
            { id: 'call_a', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'call_a', content: 'out' },
        {
          role: 'assistant',
          reasoning_content: 'unsigned-3',
          content: [
            { type: 'thinking', thinking: 'missing sig' },
            { type: 'thinking', thinking: 'blank sig', signature: '  ' },
            { type: 'thinking', thinking: 'signed gw thinking', signature: 'sig-gw-789' },
            { type: 'text', text: 'final answer' },
          ],
        },
      ],
    },
    'claude-sonnet-4-5',
  );
  assert.equal(
    gwAnth.messages[1].content.some((b) => b.type === 'thinking'),
    false,
    'openaiRequestToAnthropic must not emit unsigned thinking from reasoning/reasoning_content',
  );
  const gwSecondAssistant = gwAnth.messages[3].content;
  const gwThinking = gwSecondAssistant.filter((b) => b.type === 'thinking');
  assert.equal(gwThinking.length, 1);
  assert.deepEqual(gwThinking[0], {
    type: 'thinking',
    thinking: 'signed gw thinking',
    signature: 'sig-gw-789',
  });
  assert.equal(
    gwSecondAssistant.some((b) => b.type === 'text' && b.text === 'final answer'),
    true,
  );

  // OpenAI -> OpenAI pass-through forwarding preserves reasoning_content on request & response
  let seenForwardedBody = null;
  const oaiUpstream = await startHttpServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    seenForwardedBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (seenForwardedBody.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(
        `data: ${JSON.stringify({
          id: 'cmpl_stream',
          choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: 'streamed-thought' }, finish_reason: null }],
        })}\n\n`,
      );
      res.write(
        `data: ${JSON.stringify({
          id: 'cmpl_stream',
          choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }],
        })}\n\n`,
      );
      res.end('data: [DONE]\n\n');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'cmpl_json',
        object: 'chat.completion',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              reasoning_content: 'upstream-thought',
              content: 'ok',
            },
            finish_reason: 'stop',
          },
        ],
      }),
    );
  });

  const dataDir = mkdtempSync(join(tmpdir(), 'agent-us-wp1b-'));
  const store = new Store(join(dataDir, 'engine.sqlite'));
  const pool = new AccountPool(store, { root: dataDir });
  pool.createAccount({
    preset: 'deepseek',
    label: 'OpenAI Forward',
    endpoint: `${oaiUpstream.baseUrl}/v1`,
    credential: 'sk-forward-123456',
    models: ['deepseek-reasoner'],
  });

  try {
    const fwdReq = {
      model: 'deepseek-reasoner',
      messages: [
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          reasoning_content: 'intra-turn-forwarded',
          content: null,
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }],
        },
        { role: 'tool', tool_call_id: 'c1', content: 'res' },
      ],
    };
    const jsonOut = await pool.proxyChatCompletion(fwdReq);
    assert.equal(seenForwardedBody.messages[1].reasoning_content, 'intra-turn-forwarded');
    const jsonPayload = await jsonOut.response.json();
    assert.equal(jsonPayload.choices[0].message.reasoning_content, 'upstream-thought');

    const sseOut = await pool.proxyChatCompletion({ ...fwdReq, stream: true });
    const sseText = await sseOut.response.text();
    sseOut.release();
    assert.ok(sseText.includes('"reasoning_content":"streamed-thought"'));
  } finally {
    store.close();
    await oaiUpstream.close();
    rmDirSafe(dataDir);
  }
});

test('WP2: admitted/stubbed and >32k excerpted promptOutput persists to direct_messages so Turn 2 tool messages are byte-identical to Turn 1', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-us-wp2-data-'));
  const workDir = mkdtempSync(join(tmpdir(), 'agent-us-wp2-work-'));

  // Large diverse module (>4k chars, non-sequential so counter folding leaves it intact)
  // so aci_26 admission compresses/stubs read_file output when workingSetReadMaxChars=0
  const bigWords = [
    'alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel',
    'india', 'juliet', 'kilo', 'lima', 'mike', 'november', 'oscar', 'papa',
    'quebec', 'romeo', 'sierra', 'tango', 'uniform', 'victor', 'whiskey', 'xray',
  ];
  const bigLines = [];
  for (const a of bigWords) {
    for (const b of ['Read', 'Write', 'Verify', 'Index', 'Merge']) {
      bigLines.push(`export function ${a}${b}Handler(ctx, payload) { return { op: '${a}:${b}', ok: Boolean(ctx && payload) }; }`);
    }
  }
  const bigContent = bigLines.join('\n');
  assert.ok(bigContent.length > 5000);
  writeFileSync(join(workDir, 'unrelated_big.js'), bigContent, 'utf8');
  // >32k diverse file for raw_full excerpt truncation check (non-repeating lines)
  const hugeLines = [];
  for (let i = 0; i < 650; i += 1) {
    const w1 = bigWords[i % bigWords.length];
    const w2 = bigWords[(i * 7 + 3) % bigWords.length];
    const w3 = bigWords[(i * 13 + 5) % bigWords.length];
    hugeLines.push(`entry_${w1}_${w2}_${w3}_${(i * 7919).toString(36)}: ${w1.repeat(4)}-${w2.repeat(4)}-${w3.repeat(4)}`);
  }
  const hugeContent = hugeLines.join('\n');
  assert.ok(hugeContent.length > 35000);
  writeFileSync(join(workDir, 'huge.txt'), hugeContent, 'utf8');

  const store = new Store(join(dataDir, 'engine.sqlite'));
  const pool = new AccountPool(store, { root: dataDir });
  pool.setDefaultModel('mock-wp2');

  const capturedPrompts = [];
  const scripted = new ScriptedAdapter([
    // Session 1 Turn 1 step 1: read unrelated_big.js
    async function* () {
      yield {
        type: 'block-end',
        index: 0,
        block: {
          type: 'tool-call',
          id: 'tc_big_1',
          name: 'read_file',
          arguments: JSON.stringify({ path: 'unrelated_big.js' }),
        },
      };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
    },
    // Session 1 Turn 1 step 2
    async function* (opts) {
      capturedPrompts.push({ label: 's1_t1_s2', messages: opts.messages });
      yield { type: 'text-delta', index: 0, text: 'Read unrelated_big.js.' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
    // Session 1 Turn 2 step 1
    async function* (opts) {
      capturedPrompts.push({ label: 's1_t2_s1', messages: opts.messages });
      yield { type: 'text-delta', index: 0, text: 'Turn 2 ok.' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
    // Session 2 (raw_full >32k excerpt) Turn 1 step 1
    async function* () {
      yield {
        type: 'block-end',
        index: 0,
        block: {
          type: 'tool-call',
          id: 'tc_huge_1',
          name: 'read_file',
          arguments: JSON.stringify({ path: 'huge.txt' }),
        },
      };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
    },
    // Session 2 Turn 1 step 2
    async function* (opts) {
      capturedPrompts.push({ label: 's2_t1_s2', messages: opts.messages });
      yield { type: 'text-delta', index: 0, text: 'Read huge.txt.' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
    // Session 2 Turn 2 step 1
    async function* (opts) {
      capturedPrompts.push({ label: 's2_t2_s1', messages: opts.messages });
      yield { type: 'text-delta', index: 0, text: 'Turn 2 huge ok.' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  ]);

  const direct = new DirectAgentRuntime(store, pool, {
    defaultWorkspace: workDir,
    dataRoot: dataDir,
    adapter: scripted,
  });

  try {
    // Part 1: Admitted/stubbed promptOutput under aci_26
    const s1 = direct.createSession({
      model: 'mock-wp2',
      workspaceRoot: workDir,
      permissionMode: 'full-access',
    });
    const t1 = direct.startTurn(s1.id, {
      input: 'Check status without referencing unrelated_big.',
      aciProfile: 'aci_26',
      aciOptions: { admissionMinChars: 800, workingSetReadMaxChars: 0 },
    });
    const d1 = await waitTurnDone(direct, s1.id, t1.turn.id);
    assert.equal(d1.state, 'completed', d1.error);

    const t2 = direct.startTurn(s1.id, {
      input: 'Continue.',
      aciProfile: 'aci_26',
      aciOptions: { admissionMinChars: 800, workingSetReadMaxChars: 0 },
    });
    const d2 = await waitTurnDone(direct, s1.id, t2.turn.id);
    assert.equal(d2.state, 'completed', d2.error);

    const s1t1Tool = capturedPrompts
      .find((c) => c.label === 's1_t1_s2')
      .messages.find((m) => m.role === 'tool' && m.toolCallId === 'tc_big_1');
    const s1t2Tool = capturedPrompts
      .find((c) => c.label === 's1_t2_s1')
      .messages.find((m) => m.role === 'tool' && m.toolCallId === 'tc_big_1');
    assert.ok(s1t1Tool && s1t2Tool);
    assert.ok(
      s1t1Tool.content[0].text.includes('[ACI-REF') || s1t1Tool.content[0].text.includes('[ACI-SKIP'),
      `Expected admitted ACI stub on Turn 1, got: ${s1t1Tool.content[0].text.slice(0, 160)}`,
    );
    assert.ok(s1t1Tool.content[0].text.length < bigContent.length);
    assert.equal(
      s1t2Tool.content[0].text,
      s1t1Tool.content[0].text,
      'Turn 2 reconstructed tool message must be 100% byte-identical to Turn 1 promptOutput',
    );
    const dbToolRow1 = store.db
      .prepare("SELECT content FROM direct_messages WHERE sessionId=? AND role='tool' AND toolCallId='tc_big_1'")
      .get(s1.id);
    assert.equal(dbToolRow1.content, s1t1Tool.content[0].text);

    // RUNTIME_EVENTS.TOOL_RESULT still records excerpt(raw output, 4000), not the ACI stub
    const toolEv = store.db
      .prepare("SELECT data FROM direct_events WHERE sessionId=? AND turnId=? AND type='tool/result'")
      .get(s1.id, t1.turn.id);
    const toolEvData = JSON.parse(toolEv.data);
    assert.ok(toolEvData.output.includes('alphaReadHandler'));

    // Part 2: >32k excerpted output under raw_full
    const s2 = direct.createSession({
      model: 'mock-wp2',
      workspaceRoot: workDir,
      permissionMode: 'full-access',
    });
    const t3 = direct.startTurn(s2.id, { input: 'Read huge.txt', aciProfile: 'raw_full' });
    assert.equal((await waitTurnDone(direct, s2.id, t3.turn.id)).state, 'completed');
    const t4 = direct.startTurn(s2.id, { input: 'Follow up', aciProfile: 'raw_full' });
    assert.equal((await waitTurnDone(direct, s2.id, t4.turn.id)).state, 'completed');

    const s2t1Tool = capturedPrompts
      .find((c) => c.label === 's2_t1_s2')
      .messages.find((m) => m.role === 'tool' && m.toolCallId === 'tc_huge_1');
    const s2t2Tool = capturedPrompts
      .find((c) => c.label === 's2_t2_s1')
      .messages.find((m) => m.role === 'tool' && m.toolCallId === 'tc_huge_1');
    assert.ok(s2t1Tool.content[0].text.includes('[tool read_file output spilled:'));
    assert.ok(s2t1Tool.content[0].text.length <= 32000);
    assert.equal(s2t2Tool.content[0].text, s2t1Tool.content[0].text);
    const dbToolRow2 = store.db
      .prepare("SELECT content FROM direct_messages WHERE sessionId=? AND role='tool' AND toolCallId='tc_huge_1'")
      .get(s2.id);
    assert.equal(dbToolRow2.content, s2t1Tool.content[0].text);
    // Double-check excerpt idempotency
    assert.equal(excerpt(s2t1Tool.content[0].text, 32000), s2t1Tool.content[0].text);

    // Part 3: Direct AgentLoop >32k promptOutput excerpting vs raw verifierEvents & RUNTIME_EVENTS.TOOL_RESULT
    const raw40k = 'Z'.repeat(40000);
    let capturedPromptOutputArg = null;
    let capturedRawOutputArg = null;
    const loopMessages = [
      { role: 'system', content: [{ type: 'text', text: 'SYS' }] },
      { role: 'user', content: [{ type: 'text', text: 'run huge tool' }] },
    ];
    const loopAdapter = new ScriptedAdapter([
      async function* () {
        yield {
          type: 'block-end',
          index: 0,
          block: { type: 'tool-call', id: 'tc_40k', name: 'huge_tool', arguments: '{}' },
        };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
      },
      async function* (opts) {
        capturedPrompts.push({ label: 'loop_40k_step2', messages: opts.messages });
        yield { type: 'text-delta', index: 0, text: '40k handled.' };
        yield { type: 'finish', reason: { kind: 'stop' } };
      },
    ]);
    const origAdapter = direct.kernel.inference.adapter;
    direct.kernel.inference.adapter = loopAdapter;
    const s3 = direct.createSession({ model: 'mock-wp2', workspaceRoot: workDir, permissionMode: 'full-access' });
    const t5Id = 'turn-40k-excerpt-check';
    store.db
      .prepare(
        "INSERT INTO direct_turns(id, sessionId, input, model, state, createdAt) VALUES(?,?,?,'mock-wp2','running',?)",
      )
      .run(t5Id, s3.id, 'run huge tool', Date.now());
    try {
      const loopRes = await direct.kernel.executeTurn({
        sessionId: s3.id,
        turnId: t5Id,
        input: 'run huge tool',
        model: 'mock-wp2',
        messages: loopMessages,
        tools: [
          {
            name: 'huge_tool',
            description: 'returns 40k output',
            parameters: { type: 'object', properties: {} },
            effectClass: 'read_only',
            riskLevel: 'low',
            execute: async () => raw40k,
          },
        ],
        permissionMode: 'full-access',
        onToolResult: ({ output, promptOutput }) => {
          capturedRawOutputArg = output;
          capturedPromptOutputArg = promptOutput;
        },
      });
      assert.equal(loopRes.text, '40k handled.');
      assert.equal(capturedRawOutputArg, raw40k);
      assert.equal(capturedPromptOutputArg, excerpt(raw40k, 32000));
      assert.ok(capturedPromptOutputArg.includes('[compacted 40000 chars,'));
      const step2ToolMsg = capturedPrompts
        .find((c) => c.label === 'loop_40k_step2')
        .messages.find((m) => m.role === 'tool' && m.toolCallId === 'tc_40k');
      assert.equal(step2ToolMsg.content[0].text, capturedPromptOutputArg);
      const rawEv = store.db
        .prepare("SELECT data FROM direct_events WHERE sessionId=? AND turnId=? AND type='tool/result'")
        .get(s3.id, t5Id);
      assert.equal(JSON.parse(rawEv.data).output, excerpt(raw40k, 4000));
    } finally {
      direct.kernel.inference.adapter = origAdapter;
    }
  } finally {
    await direct.close();
    store.close();
    rmDirSafe(dataDir);
    rmDirSafe(workDir);
  }
});

test('WP3 & WP6.3: maxSteps defaults to 40, accepts 60..80 overrides, and wires aci_31 / full_aci / aci_26 / aci_25 profiles', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-us-wp3-data-'));
  const workDir = mkdtempSync(join(tmpdir(), 'agent-us-wp3-work-'));
  const store = new Store(join(dataDir, 'engine.sqlite'));
  const pool = new AccountPool(store, { root: dataDir });
  pool.setDefaultModel('mock-wp3');

  const observedBudgets = [];
  const scripted = new ScriptedAdapter([
    async function* () {
      yield { type: 'text-delta', index: 0, text: 'OK' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  ]);

  const direct = new DirectAgentRuntime(store, pool, {
    defaultWorkspace: workDir,
    dataRoot: dataDir,
    adapter: scripted,
  });
  const origExecuteTurn = direct.kernel.executeTurn.bind(direct.kernel);
  direct.kernel.executeTurn = async (opts) => {
    observedBudgets.push({
      turnId: opts.turnId,
      maxSteps: opts.budget?.maxSteps,
      aciProfile: opts.aci?.aciProfile,
      engineDtocPolicy: opts.aci?.engine?.dtocPolicy,
      engineMinNetSavings: opts.aci?.engine?.minNetSavingsTokens,
    });
    return origExecuteTurn(opts);
  };

  try {
    const sess = direct.createSession({ model: 'mock-wp3', workspaceRoot: workDir });

    const runAndInspect = async (turnOpts) => {
      const { turn } = direct.startTurn(sess.id, turnOpts);
      const done = await waitTurnDone(direct, sess.id, turn.id);
      assert.equal(done.state, 'completed', done.error);
      const job = store.db.prepare('SELECT payload FROM runtime_jobs WHERE turnId=?').get(turn.id);
      const payload = JSON.parse(job.payload);
      const obs = observedBudgets.find((b) => b.turnId === turn.id);
      const completedEv = store.db
        .prepare("SELECT data FROM direct_events WHERE turnId=? AND type='turn/completed' ORDER BY seq DESC LIMIT 1")
        .get(turn.id);
      const completedData = JSON.parse(completedEv.data);
      return { payload, obs, completedData };
    };

    // Default maxSteps === 40 and default aciProfile === full_aci
    const rDefault = await runAndInspect({ input: 'default step check' });
    assert.equal(rDefault.payload.maxSteps, 40);
    assert.equal(rDefault.obs.maxSteps, 40);
    assert.equal(rDefault.obs.aciProfile, 'full_aci');
    if (VALID_DTOC_POLICIES.includes('cache_aware_v31')) {
      assert.equal(rDefault.completedData.aciTelemetry.dtocPolicy, 'cache_aware_v31');
    } else {
      assert.notEqual(rDefault.completedData.aciTelemetry.dtocPolicy, 'trajectory_eviction_v26');
    }

    // Explicit maxSteps 60 and 80 (and clamp above 80)
    const r60 = await runAndInspect({ input: 'explicit 60', maxSteps: 60 });
    assert.equal(r60.payload.maxSteps, 60);
    assert.equal(r60.obs.maxSteps, 60);

    const r80 = await runAndInspect({ input: 'explicit 80', maxSteps: 80 });
    assert.equal(r80.payload.maxSteps, 80);
    assert.equal(r80.obs.maxSteps, 80);
    // Also prove AgentLoop itself honors 80 (not clamped to 60!) via initial checkpoint stateJson
    const r80TurnRow = store.db
      .prepare("SELECT id FROM direct_turns WHERE sessionId=? AND input='explicit 80' ORDER BY createdAt DESC LIMIT 1")
      .get(sess.id);
    const r80Cp = store.db
      .prepare('SELECT stateJson FROM runtime_checkpoints WHERE turnId=? AND step=0 ORDER BY createdAt ASC LIMIT 1')
      .get(r80TurnRow.id);
    assert.equal(JSON.parse(r80Cp.stateJson).maxSteps, 80);

    const rCap = await runAndInspect({ input: 'clamp 120', maxSteps: 120 });
    assert.equal(rCap.payload.maxSteps, 80);
    assert.equal(rCap.obs.maxSteps, 80);

    // aciOptions.maxSteps override + aci_31 + option forwarding
    const rAci31 = await runAndInspect({
      input: 'aci_31 explicit',
      aciProfile: 'aci_31',
      aciOptions: {
        maxSteps: 68,
        workingSetReadMaxChars: 5000,
        minNetSavingsTokens: 2100,
        evictionCooldownSteps: 4,
      },
    });
    assert.equal(rAci31.payload.maxSteps, 68);
    assert.equal(rAci31.obs.maxSteps, 68);
    assert.equal(rAci31.obs.aciProfile, 'aci_31');
    assert.equal(rAci31.obs.engineMinNetSavings, 2100);
    assert.equal(rAci31.completedData.aciTelemetry.aciProfile, 'aci_31');
    if (VALID_DTOC_POLICIES.includes('cache_aware_v31')) {
      assert.equal(rAci31.completedData.aciTelemetry.dtocPolicy, 'cache_aware_v31');
    }

    // Legacy profile compatibility: aci_25 and aci_26
    const r25 = await runAndInspect({ input: 'aci_25 compat', aciProfile: 'aci_25' });
    assert.equal(r25.completedData.aciTelemetry.dtocPolicy, 'phase_watermark_v25');

    const r26 = await runAndInspect({ input: 'aci_26 compat', aciProfile: 'aci_26' });
    assert.equal(r26.completedData.aciTelemetry.dtocPolicy, 'trajectory_eviction_v26');
  } finally {
    await direct.close();
    store.close();
    rmDirSafe(dataDir);
    rmDirSafe(workDir);
  }
});
