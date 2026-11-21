import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import { rmDirSafe, withTimeout } from './fixtures.js';
import { Store } from '../src/store.js';
import { AccountPool } from '../src/pool.js';
import { DirectAgentRuntime } from '../src/direct-agent.js';
import { api } from '../src/api.js';
import { ControlPlane } from '../src/governance/control-plane.js';

class ScriptedAdapter extends LlmAdapter {
  constructor(handler) {
    super();
    this.handler = handler;
    this.calls = [];
  }
  async *stream(options) {
    this.calls.push({ model: options.model, messages: structuredClone(options.messages) });
    yield* this.handler(options, this.calls.length - 1);
  }
}

function sha256Buf(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function initGitRepo(dir, files = { 'README.md': 'root repo\n' }) {
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@agent-us.local'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Agent US Test'], { cwd: dir });
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    if (Buffer.isBuffer(content)) {
      writeFileSync(full, content);
    } else {
      writeFileSync(full, content, 'utf8');
    }
  }
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir, stdio: 'ignore' });
}

test('Fix C1/C2/C4/C8: two isolated worktree nodes persist verifiable artifacts without polluting parent workspace, surviving restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-us-fixc-basic-'));
  const workDir = join(dir, 'repo');
  const dbPath = join(dir, 'engine.sqlite');
  mkdirSync(workDir, { recursive: true });
  initGitRepo(workDir);

  let store = new Store(dbPath);
  const pool = new AccountPool(store, { root: dir });
  pool.setDefaultModel('mock-art');

  const adapter = new ScriptedAdapter(async function* (opts) {
    const userText = opts.messages.findLast((m) => m.role === 'user')?.content?.[0]?.text ?? '';
    const hasTool = opts.messages.some((m) => m.role === 'tool');
    if (!hasTool && userText.includes('CREATE_FILE:')) {
      const target = /CREATE_FILE:(\S+)/.exec(userText)[1];
      yield {
        type: 'block-end',
        index: 0,
        block: {
          type: 'tool-call',
          id: `tc-${target}`,
          name: 'write_file',
          arguments: JSON.stringify({ path: target, content: `payload-for-${target}\n` }),
        },
      };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
      return;
    }
    // Intentionally omit any artifact:// URI from model text to prove persistence doesn't rely on regex parsing
    yield { type: 'text-delta', index: 0, text: 'Completed isolated task cleanly.' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  });

  let direct = new DirectAgentRuntime(store, pool, {
    defaultWorkspace: workDir,
    dataRoot: dir,
    adapter,
  });

  try {
    const sess = direct.createSession({ workspaceRoot: workDir, permissionMode: 'auto-safe' });
    const out = await direct.swarmOrchestrator.startRun({
      sessionId: sess.id,
      goal: 'Parallel artifact capture',
      workspaceRoot: workDir,
      maxConcurrency: 2,
      nodes: [
        {
          nodeKey: 'node-a',
          taskType: 'implementation',
          objective: 'CREATE_FILE:alpha.txt',
          dependencies: [],
          isolatedWorktree: true,
          isolationMode: 'worktree',
          toolAllow: ['write_file', 'read_file'],
        },
        {
          nodeKey: 'node-b',
          taskType: 'implementation',
          objective: 'CREATE_FILE:beta.txt',
          dependencies: [],
          isolatedWorktree: true,
          isolationMode: 'worktree',
          toolAllow: ['write_file', 'read_file'],
        },
      ],
    });

    assert.equal(out.status, 'completed');
    // Parent workspace must NOT be polluted
    assert.equal(existsSync(join(workDir, 'alpha.txt')), false);
    assert.equal(existsSync(join(workDir, 'beta.txt')), false);

    // Worktrees cleaned up ONLY after archiving
    const activeLeases = store.db
      .prepare("SELECT COUNT(*) AS n FROM worktree_leases WHERE status='active'")
      .get().n;
    assert.equal(activeLeases, 0);

    // Artifact manager must exist and expose both verifiable artifacts
    assert.ok(direct.artifactManager, 'DirectAgentRuntime must expose artifactManager');
    const arts = direct.artifactManager.listArtifacts({ runId: out.runId });
    assert.equal(arts.length, 2, 'Both isolated worktree nodes must persist durable artifacts');

    const artA = arts.find((a) => a.nodeKey === 'node-a');
    const artB = arts.find((a) => a.nodeKey === 'node-b');
    assert.ok(artA && artB);
    assert.ok(artA.baseCommit && artA.bundleSha256 && artA.uri);
    assert.ok(artB.baseCommit && artB.bundleSha256 && artB.uri);

    const nodeA = out.nodes.find((n) => n.nodeKey === 'node-a');
    assert.ok(nodeA.artifactUris.includes(artA.uri), 'Node artifactUris must include structured artifact URI');

    // Restart Store & DirectAgentRuntime -> artifacts & SHA-256 digests survive intact
    await direct.close();
    store.close();

    store = new Store(dbPath);
    const pool2 = new AccountPool(store, { root: dir });
    pool2.setDefaultModel('mock-art');
    direct = new DirectAgentRuntime(store, pool2, {
      defaultWorkspace: workDir,
      dataRoot: dir,
      adapter,
    });

    const controlPlane = new ControlPlane({ store, pool: pool2, directAgent: direct });
    const token = 'fixc-restart-token-123456';
    const app = api(null, token, undefined, { pool: pool2, directAgent: direct, controlPlane });
    const auth = { authorization: `Bearer ${token}` };

    try {
      const listRes = await app.inject({
        method: 'GET',
        url: `/v1/swarm/runs/${out.runId}/artifacts`,
        headers: auth,
      });
      assert.equal(listRes.statusCode, 200);
      assert.equal(listRes.json().items.length, 2);

      const verRes = await app.inject({
        method: 'POST',
        url: `/v1/swarm/runs/${out.runId}/artifacts/${artA.id}/verify`,
        headers: auth,
      });
      assert.equal(verRes.statusCode, 200);
      assert.equal(verRes.json().ok, true);
      assert.equal(verRes.json().bundleSha256, artA.bundleSha256);

      const fileA = direct.artifactManager.readArtifactFile(artA.id, 'alpha.txt');
      assert.equal(fileA.text, 'payload-for-alpha.txt\n');
      assert.equal(fileA.verified, true);
      const fileB = direct.artifactManager.readArtifactFile(artB.id, 'beta.txt');
      assert.equal(fileB.text, 'payload-for-beta.txt\n');
      assert.equal(fileB.verified, true);
    } finally {
      controlPlane.close();
      await app.close();
    }
  } finally {
    await direct.close();
    store.close();
    rmDirSafe(dir);
  }
});

test('Fix C6: successor nodes read real predecessor artifact files (both worktree handoff dir and read_swarm_artifact tool)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-us-fixc-handoff-'));
  const workDir = join(dir, 'repo');
  mkdirSync(workDir, { recursive: true });
  initGitRepo(workDir);

  const store = new Store(join(dir, 'engine.sqlite'));
  const pool = new AccountPool(store, { root: dir });
  pool.setDefaultModel('mock-handoff');

  const secretContent = 'SECRET_HANDOFF_PROOF_987654\n';
  let observedByWtSuccessor = null;
  let observedByRoSuccessor = null;

  const adapter = new ScriptedAdapter(async function* (opts) {
    const userText = opts.messages.findLast((m) => m.role === 'user')?.content?.[0]?.text ?? '';
    const toolMsgs = opts.messages.filter((m) => m.role === 'tool');

    if (userText.includes('ROLE:PRODUCER')) {
      if (!toolMsgs.length) {
        yield {
          type: 'block-end',
          index: 0,
          block: {
            type: 'tool-call',
            id: 'tc-prod-write',
            name: 'write_file',
            arguments: JSON.stringify({ path: 'generated/output.txt', content: secretContent }),
          },
        };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
        return;
      }
      // Deliberately vague text summary without the secret content!
      yield { type: 'text-delta', index: 0, text: 'Producer finished.' };
      yield { type: 'finish', reason: { kind: 'stop' } };
      return;
    }

    if (userText.includes('ROLE:CONSUMER_WT')) {
      if (!toolMsgs.length) {
        // Must have structured handoff path in prompt context
        assert.match(userText, /\.agent-us-handoff\/producer\/generated\/output\.txt/);
        yield {
          type: 'block-end',
          index: 0,
          block: {
            type: 'tool-call',
            id: 'tc-wt-read',
            name: 'read_file',
            arguments: JSON.stringify({ path: '.agent-us-handoff/producer/generated/output.txt' }),
          },
        };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
        return;
      }
      observedByWtSuccessor = toolMsgs[0]?.content?.[0]?.text ?? '';
      yield { type: 'text-delta', index: 0, text: `WT consumer read: ${observedByWtSuccessor}` };
      yield { type: 'finish', reason: { kind: 'stop' } };
      return;
    }

    if (userText.includes('ROLE:CONSUMER_RO')) {
      if (!toolMsgs.length) {
        yield {
          type: 'block-end',
          index: 0,
          block: {
            type: 'tool-call',
            id: 'tc-ro-read',
            name: 'read_swarm_artifact',
            arguments: JSON.stringify({ nodeKey: 'producer', path: 'generated/output.txt' }),
          },
        };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
        return;
      }
      observedByRoSuccessor = toolMsgs[0]?.content?.[0]?.text ?? '';
      yield { type: 'text-delta', index: 0, text: `RO consumer read: ${observedByRoSuccessor}` };
      yield { type: 'finish', reason: { kind: 'stop' } };
      return;
    }

    yield { type: 'text-delta', index: 0, text: 'default' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  });

  const direct = new DirectAgentRuntime(store, pool, {
    defaultWorkspace: workDir,
    dataRoot: dir,
    adapter,
  });

  try {
    const sess = direct.createSession({ workspaceRoot: workDir, permissionMode: 'auto-safe' });
    const out = await direct.swarmOrchestrator.startRun({
      sessionId: sess.id,
      goal: 'Artifact handoff test',
      workspaceRoot: workDir,
      maxConcurrency: 2,
      nodes: [
        {
          nodeKey: 'producer',
          taskType: 'implementation',
          objective: 'ROLE:PRODUCER create generated/output.txt',
          dependencies: [],
          isolatedWorktree: true,
          isolationMode: 'worktree',
          toolAllow: ['write_file', 'read_file'],
        },
        {
          nodeKey: 'consumer-wt',
          taskType: 'implementation',
          objective: 'ROLE:CONSUMER_WT inspect predecessor artifact via handoff dir',
          dependencies: ['producer'],
          isolatedWorktree: true,
          isolationMode: 'worktree',
          toolAllow: ['read_file'],
        },
        {
          nodeKey: 'consumer-ro',
          taskType: 'review',
          objective: 'ROLE:CONSUMER_RO inspect predecessor artifact via tool',
          dependencies: ['producer'],
          isolationMode: 'shared_readonly',
        },
      ],
    });

    assert.equal(out.status, 'completed');
    assert.match(String(observedByWtSuccessor || ''), /SECRET_HANDOFF_PROOF_987654/);
    assert.match(String(observedByRoSuccessor || ''), /SECRET_HANDOFF_PROOF_987654/);
    // Parent workspace must remain completely unpolluted
    assert.equal(existsSync(join(workDir, 'generated')), false);
    assert.equal(existsSync(join(workDir, '.agent-us-handoff')), false);
  } finally {
    await direct.close();
    store.close();
    rmDirSafe(dir);
  }
});

test('Fix C3/C7: artifacts capture tracked edit, untracked add, deletion, rename, binary content & mode, and apply cleanly to parent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-us-fixc-types-'));
  const workDir = join(dir, 'repo');
  mkdirSync(workDir, { recursive: true });
  initGitRepo(workDir, {
    'tracked.txt': 'original line\n',
    'obsolete.txt': 'remove me\n',
    'before-rename.txt': 'movable content line 1\nmovable content line 2\n',
    'run.sh': '#!/bin/sh\necho hi\n',
    'disk-exec.sh': '#!/bin/sh\necho disk\n',
  });

  const store = new Store(join(dir, 'engine.sqlite'));
  const pool = new AccountPool(store, { root: dir });
  pool.setDefaultModel('mock-types');
  const direct = new DirectAgentRuntime(store, pool, {
    defaultWorkspace: workDir,
    dataRoot: dir,
  });

  try {
    assert.ok(direct.artifactManager, 'artifactManager must exist');
    const wt = await direct.worktreeIsolator.acquire(workDir, {
      ownerId: 'test-owner',
      runId: 'run-types-1',
      nodeKey: 'mutate-all',
    });

    // Perform all change types inside isolated worktree
    writeFileSync(join(wt.path, 'tracked.txt'), 'modified line\n', 'utf8');
    mkdirSync(join(wt.path, 'nested'), { recursive: true });
    writeFileSync(join(wt.path, 'nested', 'added.txt'), 'brand new file\n', 'utf8');
    rmSync(join(wt.path, 'obsolete.txt'));
    writeFileSync(
      join(wt.path, 'after-rename.txt'),
      readFileSync(join(wt.path, 'before-rename.txt')),
    );
    rmSync(join(wt.path, 'before-rename.txt'));
    const binaryPayload = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x42]);
    writeFileSync(join(wt.path, 'icon.bin'), binaryPayload);
    // Test BOTH explicit git index chmod (+x) AND (on POSIX) real disk chmodSync(0o755)
    execFileSync('git', ['update-index', '--chmod=+x', 'run.sh'], { cwd: wt.path });
    if (process.platform !== 'win32') {
      chmodSync(join(wt.path, 'disk-exec.sh'), 0o755);
    }

    const artifact = await direct.artifactManager.archiveWorktree({
      runId: 'run-types-1',
      nodeId: 'node-types-1',
      nodeKey: 'mutate-all',
      attempt: 1,
      ownerId: 'test-owner',
      workspaceRoot: workDir,
      worktreePath: wt.path,
      worktreeLeaseId: wt.leaseId,
    });
    await wt.release({ archivedArtifactId: artifact.id });

    const verify = direct.artifactManager.verifyArtifact(artifact.id);
    assert.equal(verify.ok, true);

    const byPath = new Map(artifact.manifest.entries.map((e) => [e.path, e]));
    assert.equal(byPath.get('tracked.txt')?.changeType, 'modified');
    assert.equal(byPath.get('nested/added.txt')?.changeType, 'added');
    assert.equal(byPath.get('obsolete.txt')?.changeType, 'deleted');
    assert.equal(byPath.get('after-rename.txt')?.changeType, 'renamed');
    assert.equal(byPath.get('after-rename.txt')?.previousPath, 'before-rename.txt');
    assert.equal(byPath.get('icon.bin')?.changeType, 'added');
    assert.equal(byPath.get('icon.bin')?.binary, true);
    assert.equal(byPath.get('icon.bin')?.sha256, sha256Buf(binaryPayload));
    assert.equal(byPath.get('run.sh')?.mode, '100755');
    if (process.platform !== 'win32') {
      assert.equal(byPath.get('disk-exec.sh')?.mode, '100755');
    }

    // Parent is still untouched before explicit apply (simulate CRLF checkout on parent tracked.txt to ensure no false conflict!)
    assert.equal(readFileSync(join(workDir, 'tracked.txt'), 'utf8'), 'original line\n');
    writeFileSync(join(workDir, 'tracked.txt'), 'original line\r\n', 'utf8');
    assert.equal(existsSync(join(workDir, 'obsolete.txt')), true);
    assert.equal(existsSync(join(workDir, 'icon.bin')), false);

    // Explicit guarded apply-to-parent
    const applied = direct.artifactManager.applyToParent(artifact.id, {
      workspaceRoot: workDir,
      permissionMode: 'auto-safe',
    });
    assert.equal(applied.ok, true);
    assert.equal(applied.status, 'applied');
    assert.equal(readFileSync(join(workDir, 'tracked.txt'), 'utf8'), 'modified line\n');
    assert.equal(readFileSync(join(workDir, 'nested', 'added.txt'), 'utf8'), 'brand new file\n');
    assert.equal(existsSync(join(workDir, 'obsolete.txt')), false);
    assert.equal(existsSync(join(workDir, 'before-rename.txt')), false);
    assert.equal(existsSync(join(workDir, 'after-rename.txt')), true);
    assert.deepEqual(readFileSync(join(workDir, 'icon.bin')), binaryPayload);
    if (process.platform !== 'win32') {
      assert.ok((statSync(join(workDir, 'run.sh')).mode & 0o111) !== 0);
      assert.ok((statSync(join(workDir, 'disk-exec.sh')).mode & 0o111) !== 0);
    }
  } finally {
    await direct.close();
    store.close();
    rmDirSafe(dir);
  }
});

test('Fix C5/C8: artifact persistence failure prevents node/turn completed status and preserves unarchived worktree', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-us-fixc-savefail-'));
  const workDir = join(dir, 'repo');
  mkdirSync(workDir, { recursive: true });
  initGitRepo(workDir);

  const store = new Store(join(dir, 'engine.sqlite'));
  const pool = new AccountPool(store, { root: dir });
  pool.setDefaultModel('mock-fail');

  const adapter = new ScriptedAdapter(async function* (opts) {
    const hasTool = opts.messages.some((m) => m.role === 'tool');
    if (!hasTool) {
      yield {
        type: 'block-end',
        index: 0,
        block: {
          type: 'tool-call',
          id: 'tc-write-important',
          name: 'write_file',
          arguments: JSON.stringify({ path: 'important.txt', content: 'must not be lost\n' }),
        },
      };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
      return;
    }
    yield { type: 'text-delta', index: 0, text: 'Wrote important.txt' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  });

  const direct = new DirectAgentRuntime(store, pool, {
    defaultWorkspace: workDir,
    dataRoot: dir,
    adapter,
  });

  try {
    assert.ok(direct.artifactManager, 'artifactManager must exist');
    // Inject deterministic persistence failure
    direct.artifactManager.failNextArchive = new Error('SIMULATED_ARTIFACT_DISK_FULL');

    const sess = direct.createSession({ workspaceRoot: workDir, permissionMode: 'auto-safe' });
    const out = await direct.swarmOrchestrator.startRun({
      sessionId: sess.id,
      goal: 'Fail artifact archive',
      workspaceRoot: workDir,
      maxReplans: 0,
      nodes: [
        {
          nodeKey: 'writer',
          taskType: 'implementation',
          objective: 'Write important.txt',
          dependencies: [],
          isolatedWorktree: true,
          isolationMode: 'worktree',
          toolAllow: ['write_file'],
        },
      ],
    });

    const writerNode = out.nodes.find((n) => n.nodeKey === 'writer');
    assert.notEqual(writerNode.status, 'completed', 'Node MUST NOT be marked completed if artifact archive fails');
    assert.equal(out.status, 'failed');

    // Unarchived dirty worktree must be preserved on disk, not silently deleted
    const preserved = store.db
      .prepare("SELECT * FROM worktree_leases WHERE runId=? AND nodeKey='writer' ORDER BY createdAt DESC LIMIT 1")
      .get(out.runId);
    assert.ok(preserved, 'Worktree lease must exist');
    assert.equal(preserved.status, 'preserved');
    assert.equal(existsSync(join(preserved.worktreePath, 'important.txt')), true);
  } finally {
    await direct.close();
    store.close();
    rmDirSafe(dir);
  }
});

test('Fix C8/C9: interrupt after write rehydrates preserved worktree on recovery, and missing worktree with write receipts enters reconciliation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-us-fixc-recovery-'));
  const workDir = join(dir, 'repo');
  const dbPath = join(dir, 'engine.sqlite');
  mkdirSync(workDir, { recursive: true });
  initGitRepo(workDir);

  let releaseHang;
  let reachedAfterWriteResolve;
  const reachedAfterWrite = new Promise((r) => {
    reachedAfterWriteResolve = r;
  });

  const preCrashAdapter = new ScriptedAdapter(async function* (opts) {
    const hasTool = opts.messages.some((m) => m.role === 'tool');
    if (!hasTool) {
      yield {
        type: 'block-end',
        index: 0,
        block: {
          type: 'tool-call',
          id: 'tc-partial-write',
          name: 'write_file',
          arguments: JSON.stringify({ path: 'partial.txt', content: 'SURVIVED_INTERRUPT_42\n' }),
        },
      };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
      return;
    }
    // Step 1 reached after write_file finished & checkpoint saved; hang until shutdown/interrupt
    reachedAfterWriteResolve();
    await new Promise((resolve, reject) => {
      releaseHang = resolve;
      opts.signal?.addEventListener(
        'abort',
        () => reject(new DOMException('Interrupted by shutdown', 'AbortError')),
        { once: true },
      );
    });
  });

  let store = new Store(dbPath);
  const pool1 = new AccountPool(store, { root: dir });
  pool1.setDefaultModel('mock-c9');
  let direct = new DirectAgentRuntime(store, pool1, {
    defaultWorkspace: workDir,
    dataRoot: dir,
    adapter: preCrashAdapter,
  });

  try {
    const sess = direct.createSession({ workspaceRoot: workDir, permissionMode: 'auto-safe' });
    const submitted = direct.swarmOrchestrator.submitRun({
      sessionId: sess.id,
      goal: 'Interrupt mid-worktree',
      workspaceRoot: workDir,
      nodes: [
        {
          nodeKey: 'builder',
          taskType: 'implementation',
          objective: 'Create partial.txt then verify it',
          dependencies: [],
          isolatedWorktree: true,
          isolationMode: 'worktree',
          toolAllow: ['write_file', 'read_file'],
        },
      ],
    });

    await withTimeout(reachedAfterWrite, 20000, 'swarm-artifacts reachedAfterWrite barrier');
    await direct.close();
    releaseHang?.();
    store.close();

    // Part A: Reboot -> preserved worktree is rehydrated so resumed node reads partial.txt directly!
    let readAfterResume = null;
    const postCrashAdapter = new ScriptedAdapter(async function* (opts) {
      const toolMsgs = opts.messages.filter((m) => m.role === 'tool');
      const alreadyRead = toolMsgs.some((m) => String(m.content?.[0]?.text || '').includes('SURVIVED_INTERRUPT_42'));
      if (!alreadyRead) {
        yield {
          type: 'block-end',
          index: 0,
          block: {
            type: 'tool-call',
            id: 'tc-verify-after-resume',
            name: 'read_file',
            arguments: JSON.stringify({ path: 'partial.txt' }),
          },
        };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
        return;
      }
      readAfterResume = toolMsgs.at(-1)?.content?.[0]?.text ?? '';
      yield { type: 'text-delta', index: 0, text: 'Confirmed partial.txt persisted across interrupt.' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    });

    store = new Store(dbPath);
    const pool2 = new AccountPool(store, { root: dir });
    pool2.setDefaultModel('mock-c9');
    direct = new DirectAgentRuntime(store, pool2, {
      defaultWorkspace: workDir,
      dataRoot: dir,
      adapter: postCrashAdapter,
    });

    const finished = await direct.swarmOrchestrator.waitForRun(submitted.runId, { timeoutMs: 12000 });
    assert.equal(finished.status, 'completed');
    assert.match(String(readAfterResume || ''), /SURVIVED_INTERRUPT_42/);
    const arts = direct.artifactManager.listArtifacts({ runId: submitted.runId });
    assert.equal(arts.length, 1);
    assert.equal(direct.artifactManager.readArtifactFile(arts[0].id, 'partial.txt').text, 'SURVIVED_INTERRUPT_42\n');

    // Part B: If worktree directory was physically lost after recorded write receipt, recovery parks in reconciling!
    const lostRun = direct.swarmOrchestrator.submitRun({
      sessionId: sess.id,
      goal: 'Lost worktree consistency check',
      workspaceRoot: workDir,
      nodes: [
        {
          nodeKey: 'lost-builder',
          taskType: 'implementation',
          objective: 'Write lost.txt',
          dependencies: [],
          isolatedWorktree: true,
          isolationMode: 'worktree',
          toolAllow: ['write_file'],
        },
      ],
    });
    const lostNode = direct.swarmOrchestrator.getRun(lostRun.runId).nodes[0];
    const lostChild = direct.sessionRepo.createSession({
      title: 'lost child',
      workspaceRoot: workDir,
      parentSessionId: sess.id,
      rootSessionId: sess.id,
    });
    const now = Date.now();
    store.tx(() => {
      store.db
        .prepare("UPDATE swarm_nodes SET status='running', childSessionId=?, childTurnId='turn-lost-wt' WHERE id=?")
        .run(lostChild.id, lostNode.id);
      store.db
        .prepare("INSERT INTO direct_turns(id, sessionId, input, model, state, phase, step, createdAt) VALUES('turn-lost-wt',?,'write','mock-c9','running','checkpoint',1,?)")
        .run(lostChild.id, now);
      store.db
        .prepare(
          `INSERT INTO tool_receipts(
            id, sessionId, turnId, callId, toolName, riskLevel, effectClass,
            replayable, outward, argsDigest, status, durationMs, createdAt, updatedAt
          ) VALUES('rcpt-lost-wt',?,'turn-lost-wt','tc-lost','write_file','medium','reversible_write',1,0,'deadbeef','finished',10,?,?)`,
        )
        .run(lostChild.id, now, now);
      store.db
        .prepare(
          `INSERT INTO worktree_leases(
            id, ownerId, sessionId, runId, nodeKey, workspaceRoot, worktreePath, status, createdAt
          ) VALUES('wt-missing-1',?,?,?,?,?,?,'preserved',?)`,
        )
        .run(lostChild.id, lostChild.id, lostRun.runId, 'lost-builder', workDir, join(dir, 'nonexistent-wt'), now);
    });

    await direct.close();
    store.close();

    store = new Store(dbPath);
    const pool3 = new AccountPool(store, { root: dir });
    pool3.setDefaultModel('mock-c9');
    direct = new DirectAgentRuntime(store, pool3, {
      defaultWorkspace: workDir,
      dataRoot: dir,
      adapter: postCrashAdapter,
    });

    const parked = direct.swarmOrchestrator.getRun(lostRun.runId);
    assert.equal(parked.status, 'reconciling', 'Missing worktree with recorded writes MUST enter reconciling, never silently resume on clean HEAD');
    assert.equal(parked.nodes[0].status, 'reconciling');
  } finally {
    await direct.close();
    store.close();
    rmDirSafe(dir);
  }
});

test('Fix C7: guarded apply-to-parent honors permission policy and detects conflict while preserving BOTH sides and unrelated user edits', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-us-fixc-conflict-'));
  const workDir = join(dir, 'repo');
  mkdirSync(workDir, { recursive: true });
  initGitRepo(workDir, {
    'shared.txt': 'base version\n',
    'untouched.txt': 'stay untouched\n',
  });

  const store = new Store(join(dir, 'engine.sqlite'));
  const pool = new AccountPool(store, { root: dir });
  pool.setDefaultModel('mock-conflict');
  const direct = new DirectAgentRuntime(store, pool, {
    defaultWorkspace: workDir,
    dataRoot: dir,
  });

  const controlPlane = new ControlPlane({ store, pool, directAgent: direct });
  const token = 'fixc-conflict-token-123456';
  const app = api(null, token, undefined, { pool, directAgent: direct, controlPlane });
  const auth = { authorization: `Bearer ${token}` };

  try {
    const sess = direct.createSession({ workspaceRoot: workDir, permissionMode: 'auto-safe' });
    const runId = 'run-conflict-1';
    const now = Date.now();
    store.tx(() => {
      store.db
        .prepare(
          `INSERT INTO swarm_runs(
            id, sessionId, goal, status, strategyJson, budgetJson, usageJson, workspaceRoot, permissionMode, createdAt, updatedAt
          ) VALUES(?,?,?,'completed','{}','{}','{}',?,'auto-safe',?,?)`,
        )
        .run(runId, sess.id, 'Conflict apply test', workDir, now, now);
    });

    const wt = await direct.worktreeIsolator.acquire(workDir, {
      ownerId: 'conflict-worker',
      runId,
      nodeKey: 'edit-shared',
    });
    writeFileSync(join(wt.path, 'shared.txt'), 'worker isolated edit\n', 'utf8');
    writeFileSync(join(wt.path, 'worker-new.txt'), 'new file from worker\n', 'utf8');

    const artifact = await direct.artifactManager.archiveWorktree({
      runId,
      nodeId: 'node-conflict-1',
      nodeKey: 'edit-shared',
      attempt: 1,
      ownerId: 'conflict-worker',
      workspaceRoot: workDir,
      worktreePath: wt.path,
      worktreeLeaseId: wt.leaseId,
    });
    await wt.release({ archivedArtifactId: artifact.id });

    // Permission policy checks: read-only denied, approval without approved=true denied
    const roRes = await app.inject({
      method: 'POST',
      url: `/v1/swarm/runs/${runId}/artifacts/${artifact.id}/apply`,
      headers: auth,
      payload: { permissionMode: 'read-only' },
    });
    assert.equal(roRes.statusCode, 403);

    const apprRes = await app.inject({
      method: 'POST',
      url: `/v1/swarm/runs/${runId}/artifacts/${artifact.id}/apply`,
      headers: auth,
      payload: { permissionMode: 'approval', approved: false },
    });
    assert.equal(apprRes.statusCode, 403);

    // Concurrent user edits parent workspace's shared.txt AND creates unrelated user-note.txt
    writeFileSync(join(workDir, 'shared.txt'), 'concurrent user modification\n', 'utf8');
    writeFileSync(join(workDir, 'user-note.txt'), 'unrelated user work\n', 'utf8');

    // Guarded apply MUST detect conflict, return 409, preserve BOTH sides, and never clobber user edits
    const conflictRes = await app.inject({
      method: 'POST',
      url: `/v1/swarm/runs/${runId}/artifacts/${artifact.id}/apply`,
      headers: auth,
      payload: { permissionMode: 'auto-safe' },
    });
    assert.equal(conflictRes.statusCode, 409);
    const body = conflictRes.json();
    assert.equal(body.status, 'conflict');
    assert.equal(body.ok, false);
    assert.ok(body.conflicts.some((c) => c.path === 'shared.txt' && c.parentPreserved && c.artifactPreserved));

    // Parent user edit & unrelated files preserved untouched
    assert.equal(readFileSync(join(workDir, 'shared.txt'), 'utf8'), 'concurrent user modification\n');
    assert.equal(readFileSync(join(workDir, 'user-note.txt'), 'utf8'), 'unrelated user work\n');
    // Worker artifact side STILL preserved and verifiable
    assert.equal(direct.artifactManager.verifyArtifact(artifact.id).ok, true);
    assert.equal(direct.artifactManager.readArtifactFile(artifact.id, 'shared.txt').text, 'worker isolated edit\n');
  } finally {
    controlPlane.close();
    await app.close();
    await direct.close();
    store.close();
    rmDirSafe(dir);
  }
});

test('Fix C10: stale attempt/fence cannot overwrite newer attempt artifact or delete re-bound worktree', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-us-fixc-fence-'));
  const workDir = join(dir, 'repo');
  mkdirSync(workDir, { recursive: true });
  initGitRepo(workDir);

  const store = new Store(join(dir, 'engine.sqlite'));
  const pool = new AccountPool(store, { root: dir });
  pool.setDefaultModel('mock-fence');
  const direct = new DirectAgentRuntime(store, pool, {
    defaultWorkspace: workDir,
    dataRoot: dir,
  });

  try {
    assert.ok(direct.artifactManager, 'artifactManager must exist');
    const job = direct.jobQueue.enqueue({
      kind: 'swarm_node_execute',
      sessionId: 'sess-f',
      turnId: 'swarm:run-f:n1',
      taskId: 'run-f',
      payload: { runId: 'run-f', nodeId: 'node-f', nodeKey: 'n1', sessionId: 'sess-f', planVersion: 1, attemptSeq: 1 },
    });
    const claimA = direct.jobQueue.claim({ workerId: 'worker-A', kinds: ['swarm_node_execute'], leaseMs: 1000 });
    const wtA = await direct.worktreeIsolator.acquire(workDir, {
      ownerId: 'child-a',
      workerId: 'worker-A',
      runId: 'run-f',
      nodeKey: 'n1',
      jobId: job.id,
      fence: claimA.fence,
      attempt: 1,
    });
    writeFileSync(join(wtA.path, 'data.txt'), 'attempt-1\n', 'utf8');

    // Expire A and let B claim & rehydrate/rebind the worktree
    store.tx(() => {
      store.db.prepare('UPDATE runtime_jobs SET leaseExpiresAt=? WHERE id=?').run(Date.now() - 2000, job.id);
    });
    const claimB = direct.jobQueue.claim({ workerId: 'worker-B', kinds: ['swarm_node_execute'], leaseMs: 10000 });
    const wtB = await direct.worktreeIsolator.acquire(workDir, {
      ownerId: 'child-b',
      workerId: 'worker-B',
      runId: 'run-f',
      nodeKey: 'n1',
      jobId: job.id,
      fence: claimB.fence,
      attempt: 2,
      rehydrateExisting: true,
    });
    assert.equal(wtB.path, wtA.path, 'Attempt 2 should rehydrate preserved worktree');
    writeFileSync(join(wtB.path, 'data.txt'), 'attempt-2-authoritative\n', 'utf8');

    // Stale A tries to release wtA -> MUST be refused and MUST NOT delete wtB.path!
    await wtA.release({ forceDiscard: true });
    assert.equal(existsSync(wtB.path), true, 'Stale attempt 1 release MUST NOT delete worktree re-bound to attempt 2');

    // Stale A tries to archive with stale leaseGuard -> MUST throw LEASE_LOST!
    const staleGuard = () => direct.jobQueue.assertFence(job.id, claimA.fence);
    await assert.rejects(
      () =>
        direct.artifactManager.archiveWorktree({
          runId: 'run-f',
          nodeId: 'node-f',
          nodeKey: 'n1',
          jobId: job.id,
          attempt: 1,
          ownerId: 'child-a',
          fence: claimA.fence,
          workspaceRoot: workDir,
          worktreePath: wtA.path,
          leaseGuard: staleGuard,
        }),
      (err) => err.code === 'LEASE_LOST',
    );

    // Authoritative B archives and cleans up cleanly
    const validGuard = () => direct.jobQueue.assertFence(job.id, claimB.fence);
    const artB = await direct.artifactManager.archiveWorktree({
      runId: 'run-f',
      nodeId: 'node-f',
      nodeKey: 'n1',
      jobId: job.id,
      attempt: 2,
      ownerId: 'child-b',
      fence: claimB.fence,
      workspaceRoot: workDir,
      worktreePath: wtB.path,
      worktreeLeaseId: wtB.leaseId,
      leaseGuard: validGuard,
    });
    assert.equal(direct.artifactManager.readArtifactFile(artB.id, 'data.txt').text, 'attempt-2-authoritative\n');
    await wtB.release({ archivedArtifactId: artB.id, leaseGuard: validGuard });
    assert.equal(existsSync(wtB.path), false);
  } finally {
    await direct.close();
    store.close();
    rmDirSafe(dir);
  }
});
