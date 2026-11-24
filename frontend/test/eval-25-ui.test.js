import test from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateFileChanges,
  encodeUtf8Base64,
  parseUnifiedDiff,
} from '../src/utils/diff.ts';
import {
  LiveBackendClient,
  collectSwarmReviewerVerification,
  normalizeSwarmDelivery,
} from '../src/api/client.ts';

test('parseUnifiedDiff and aggregateFileChanges render structured apply_patch hunks with +add/-del and sha256After', () => {
  const patch = [
    '--- a/src/math.js',
    '+++ b/src/math.js',
    '@@ -10,4 +10,5 @@ export function sum(list) {',
    '   let total = 0;',
    '-  return list.length;',
    '+  for (const item of list) total += item;',
    '+  return total;',
    ' }',
  ].join('\n');

  const parsed = parseUnifiedDiff(patch);
  assert.equal(parsed.hunks.length, 1);
  assert.equal(parsed.hunks[0].header, '@@ -10,4 +10,5 @@ export function sum(list) {');
  assert.equal(parsed.added, 2);
  assert.equal(parsed.deleted, 1);

  const structured = aggregateFileChanges([
    {
      path: 'src/math.js',
      before: encodeUtf8Base64('before'),
      after: encodeUtf8Base64('after'),
      action: 'update',
      unifiedDiff: patch,
      additions: 2,
      deletions: 1,
      sha256After: 'abcdef0123456789',
    },
  ]);

  assert.equal(structured.length, 1);
  assert.equal(structured[0].added, 2);
  assert.equal(structured[0].deleted, 1);
  assert.equal(structured[0].hunks?.length, 1);
  assert.equal(structured[0].sha256After, 'abcdef0123456789');

  // Safe fallback to line diff when structured fields are absent
  const fallback = aggregateFileChanges([
    {
      path: 'src/plain.js',
      before: encodeUtf8Base64('a\nb\n'),
      after: encodeUtf8Base64('a\nc\nd\n'),
    },
  ]);
  assert.equal(fallback.length, 1);
  assert.equal(fallback[0].hunks, undefined);
  assert.equal(fallback[0].added, 2);
  assert.equal(fallback[0].deleted, 1);
});

test('normalizeSwarmDelivery and collectSwarmReviewerVerification preserve hardGatePassed and verification telemetry', () => {
  const delivery = normalizeSwarmDelivery({
    runId: 'run-25',
    status: 'completed',
    goal: 'Verify patch & tests',
    reviewerVerification: {
      verifiedGitDiff: true,
      diffFileCount: 3,
      diffDigest: '1234567890abcdef',
      verifiedTestExitCode: 0,
      hardGatePassed: true,
    },
  });

  assert.equal(delivery.reviewerVerification?.hardGatePassed, true);
  assert.equal(delivery.reviewerVerification?.diffFileCount, 3);
  assert.equal(delivery.reviewerVerification?.verifiedTestExitCode, 0);

  const collectedFromVerdict = collectSwarmReviewerVerification(
    {
      id: 'run-25',
      verdict: {
        verdict: 'rejected',
        accepted: false,
        reviewerVerification: {
          verifiedGitDiff: false,
          diffFileCount: 0,
          verifiedTestExitCode: 1,
          hardGatePassed: false,
        },
      },
    },
    null,
  );
  assert.equal(collectedFromVerdict?.hardGatePassed, false);
  assert.equal(collectedFromVerdict?.verifiedGitDiff, false);
  assert.equal(collectedFromVerdict?.verifiedTestExitCode, 1);
});

test('LiveBackendClient.loadTaskBundle attaches file/changed apply_patch diffs to apply_patch tool results', async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const href = String(url);
    const json = (body) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    if (href.includes('/events')) {
      return json({
        items: [
          {
            seq: 1,
            type: 'file/changed',
            createdAt: 1000,
            data: {
              path: 'src/app.js',
              before: encodeUtf8Base64('const a = 1;\n'),
              after: encodeUtf8Base64('const a = 2;\n'),
              action: 'update',
              unifiedDiff: '@@ -1,1 +1,1 @@\n-const a = 1;\n+const a = 2;',
              additions: 1,
              deletions: 1,
              sha256After: 'deadbeef1234',
            },
          },
          {
            seq: 2,
            type: 'tool/result',
            createdAt: 1005,
            data: { callId: 'call-patch-1', name: 'apply_patch', output: 'Patched 1 file', isError: false },
          },
        ],
      });
    }
    if (href.includes('/messages')) {
      return json({ items: [] });
    }
    if (href.includes('/approvals')) {
      return json({ items: [] });
    }
    if (href.includes('/usage')) {
      return json({ items: [] });
    }
    if (href.includes('/receipts')) {
      return json({ items: [] });
    }
    if (href.includes('/swarm/runs')) {
      return json({ runs: [] });
    }
    if (href.includes('/v1/sessions/sess-1')) {
      return json({ id: 'sess-1', title: 'Test', state: 'completed', workspaceRoot: '/tmp', model: 'mock', createdAt: 1, updatedAt: 2 });
    }
    return json({});
  };

  try {
    const client = new LiveBackendClient({ baseUrl: 'http://127.0.0.1:9999', token: 'test-token' });
    const bundle = await client.loadTaskBundle('sess-1');
    assert.equal(bundle.evidence.length, 1);
    assert.equal(bundle.evidence[0].tool, 'apply_patch');
    assert.equal(bundle.evidence[0].changes?.length, 1);
    assert.equal(bundle.evidence[0].changes?.[0].additions, 1);
    assert.equal(bundle.evidence[0].changes?.[0].sha256After, 'deadbeef1234');
  } finally {
    globalThis.fetch = origFetch;
  }
});
