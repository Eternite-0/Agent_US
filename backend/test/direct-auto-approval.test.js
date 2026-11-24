import test from 'node:test';
import assert from 'node:assert/strict';
import { JudgmentService } from '../src/judgment.js';
import { createDirectAutoReviewer } from '../src/tools/auto-approval.js';
import { ToolDispatcher } from '../src/tools/dispatcher.js';
import { intersectPolicies, ToolPermissionPolicy } from '../src/tools/policy.js';

const bash = {
  name: 'bash',
  meta: { requiresCommandCheck: true, riskLevel: 'high', effectClass: 'irreversible_side_effect' },
};
const write = {
  name: 'edit_file',
  meta: { riskLevel: 'medium', effectClass: 'reversible_write' },
};
const external = {
  name: 'mcp__example',
  meta: { outward: true, riskLevel: 'high', effectClass: 'external_network' },
};

async function dispatch({ mode = 'auto-review', tool = bash, args = { command: 'pwd' },
  reviewer = createDirectAutoReviewer(), tainted, policy, getLivePolicy } = {}) {
  const effects = [], requests = [], events = [];
  const dispatcher = new ToolDispatcher({
    policy, reviewApproval: reviewer,
    eventRouter: { emitPersisted: (e) => events.push(e) },
  });
  const [result] = await dispatcher.dispatchBatch({
    sessionId: 'session', turnId: 'turn', signal: new AbortController().signal,
    tools: [{ ...tool, execute: (input) => { effects.push(input); return 'executed'; } }],
    toolCalls: [{ id: 'call-1', name: tool.name, arguments: JSON.stringify(args) }],
    permissionMode: mode, tainted, getLivePolicy,
    requestApproval: (r) => { requests.push(r); return { allowed: false }; },
  });
  return { result, effects, requests, reviews: events.filter((e) => e.type === 'tool/approval_reviewed') };
}

test('the three permission modes differ on a low-risk probe and an ordinary script', async () => {
  assert.equal((await dispatch({ mode: 'approval' })).requests.length, 1);
  const auto = await dispatch();
  assert.equal(auto.result.isError, false);
  assert.equal(auto.effects.length, 1);
  assert.equal(auto.requests.length, 0);
  assert.equal(auto.reviews[0].data.source, 'local_policy');
  assert.equal(auto.reviews[0].data.decision, 'allow');
  assert.match(auto.reviews[0].data.argsDigest, /^[a-f0-9]{64}$/);
  assert.equal((await dispatch({ args: { command: 'node test.mjs' } })).requests.length, 1);
  const full = await dispatch({ mode: 'full-access', args: { command: 'node test.mjs' } });
  assert.equal(full.effects.length, 1);
  assert.equal(full.requests.length, 0);
  assert.equal(full.reviews.length, 0);
});

test('scope, taint, hard denials and explicit asks are not widened', async () => {
  for (const options of [
    { args: { command: 'pwd', cwd: 'nested' } },
    { args: { command: 'git status' } },
    { args: { command: 'echo ok > file.txt' } },
    { tool: write, args: { path: 'source.js' } },
    { tool: external, args: {} },
    { tainted: true },
    { policy: new ToolPermissionPolicy({ alwaysAskRules: ['bash'] }) },
  ]) {
    const result = await dispatch(options);
    assert.equal(result.requests.length, 1);
    assert.equal(result.effects.length, 0);
  }
  const denied = await dispatch({ args: { command: 'rm -rf /' } });
  assert.equal(denied.requests.length, 0);
  assert.equal(denied.effects.length, 0);
  assert.match(denied.result.output, /POLICY_HARD_BLOCKED/);
  for (const [parent, child, expected] of [
    ['auto-review', 'auto-safe', 'auto-review'],
    ['workspace-write', 'auto-review', 'approval'],
    ['auto-review', 'workspace-write', 'approval'],
    ['approval', 'auto-review', 'approval'],
  ]) assert.equal(intersectPolicies({ permissionMode: parent }, { permissionMode: child }).permissionMode, expected);
});

test('a configured review model must return a valid low-risk approval or fall back to the user', async () => {
  for (const [answer, expected] of [
    [{ decision: 'allow', risk: 'low' }, true],
    [{ decision: 'allow', risk: 'high' }, false],
    [{ decision: 'ask', risk: 'low' }, false],
    [null, false],
  ]) {
    const inputs = [];
    const judgment = new JudgmentService({ uses: { autoReview: true }, provider: {
      kind: 'custom', model: 'review-test', decide: async (input) => {
        inputs.push(input);
        if (!answer) throw new Error('review unavailable');
        return { answer };
      },
    } });
    const result = await dispatch({ reviewer: createDirectAutoReviewer(judgment) });
    assert.equal(inputs.length, 1);
    assert.equal(result.effects.length, Number(expected));
    assert.equal(result.requests.length, Number(!expected));
    assert.equal(result.reviews[0].data.source, 'review_model');
  }
});

test('a model approval cannot cross a live mode change while the reviewer was running', async () => {
  let mode = 'auto-review';
  const result = await dispatch({
    getLivePolicy: () => ({ permissionMode: mode }),
    reviewer: async () => { mode = 'approval'; return { allow: true, source: 'review_model' }; },
  });
  assert.equal(result.requests.length, 1);
  assert.equal(result.effects.length, 0);
});
