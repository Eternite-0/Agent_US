import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import { api } from '../src/api.js';
import { AccountPool } from '../src/pool.js';
import { Store } from '../src/store.js';
import { DirectAgentRuntime } from '../src/direct-agent.js';
import { WorkspaceRewindManager } from '../src/durable/checkpoint.js';
import { runGit, stageGitPaths } from '../src/routes/workspace-git.js';
import { rmDirSafe, withTimeout } from './fixtures.js';

class ScriptedTurnAdapter extends LlmAdapter {
  constructor(handler) {
    super();
    this.handler = handler;
    this.calls = 0;
  }

  async *stream(opts) {
    this.calls += 1;
    yield* this.handler(opts, this.calls);
  }
}

async function waitTurnTerminal(directAgent, sessionId, turnId, timeoutMs = 8000) {
  return withTimeout(
    (async () => {
      while (true) {
        const turn = directAgent.store.db.prepare('SELECT * FROM direct_turns WHERE id=?').get(turnId);
        if (turn && ['completed', 'failed', 'cancelled'].includes(turn.state)) {
          return turn;
        }
        await new Promise((r) => setTimeout(r, 20));
      }
    })(),
    timeoutMs,
    `turn ${turnId} terminal`,
  );
}

async function setupEnv(t, { adapter = null, initGit = false } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agent-us-30-snapgit-')));
  const dataDir = join(root, 'data');
  const workDir = join(root, 'workspace');
  const emptyHome = join(root, 'home');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(workDir, { recursive: true });
  mkdirSync(emptyHome, { recursive: true });
  const prevTestHome = process.env.AGENT_US_TEST_HOMEDIR;
  process.env.AGENT_US_TEST_HOMEDIR = emptyHome;

  if (initGit) {
    await runGit(workDir, ['init', '-b', 'main']);
    await runGit(workDir, ['config', 'user.name', 'Test Author']);
    await runGit(workDir, ['config', 'user.email', 'test@example.invalid']);
  }

  const store = new Store(join(dataDir, 'engine.sqlite'));
  const pool = new AccountPool(store, { root: dataDir });
  pool.setDefaultModel('mock-30');

  const usedAdapter =
    adapter ??
    new ScriptedTurnAdapter(async function* () {
      yield { type: 'text-delta', index: 0, text: 'done' };
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 4 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    });

  const directAgent = new DirectAgentRuntime(store, pool, {
    defaultWorkspace: workDir,
    dataRoot: dataDir,
    adapter: usedAdapter,
  });

  const token = randomUUID();
  const app = api(store, token, { models: [], list: () => [] }, { pool, directAgent });
  const req = (method, url, payload, auth = true) =>
    app.inject({
      method,
      url,
      payload,
      headers: auth ? { authorization: `Bearer ${token}` } : {},
    });

  t.after(async () => {
    if (prevTestHome === undefined) delete process.env.AGENT_US_TEST_HOMEDIR;
    else process.env.AGENT_US_TEST_HOMEDIR = prevTestHome;
    await directAgent.close();
    await app.close();
    store.close();
    rmDirSafe(root);
  });

  return { root, dataDir, workDir, store, pool, directAgent, adapter: usedAdapter, app, req };
}

test('True Instant Rewind protects untouched user dirty/untracked edits, reverts bash-created/clobbered files, supports binary/mode & <10ms Redo', async (t) => {
  const { workDir, store, directAgent, req } = await setupEnv(t, { initGit: true });

  // Commit initial repo baseline
  writeFileSync(join(workDir, 'committed.js'), 'export const c = 1;\n', 'utf8');
  writeFileSync(join(workDir, 'user-dirty.txt'), 'committed dirty base\n', 'utf8');
  await runGit(workDir, ['add', '.']);
  await runGit(workDir, ['commit', '-m', 'init']);

  // Pre-existing user dirty & untracked files before Turn 1
  writeFileSync(join(workDir, 'user-dirty.txt'), 'user uncommitted edit\n', 'utf8');
  writeFileSync(join(workDir, 'user-clobbered-dirty.txt'), 'user dirty v0\n', 'utf8');
  writeFileSync(join(workDir, 'user-untracked.txt'), 'keep me safe\n', 'utf8');
  mkdirSync(join(workDir, 'existing-empty-dir'), { recursive: true });
  const untouchedMtime = new Date('2024-01-01T00:00:00Z');
  utimesSync(join(workDir, 'user-untracked.txt'), untouchedMtime, untouchedMtime);

  // Scripted adapter runs tools: write_file + bash modifying/creating/deleting files
  let step = 0;
  const scripted = new ScriptedTurnAdapter(async function* () {
    step += 1;
    if (step === 1) {
      yield {
        type: 'block-end',
        index: 0,
        block: {
          type: 'tool-call',
          id: 'tc-w1',
          name: 'write_file',
          arguments: JSON.stringify({ path: 'committed.js', content: 'export const c = 2;\n' }),
        },
      };
      yield {
        type: 'block-end',
        index: 1,
        block: {
          type: 'tool-call',
          id: 'tc-w2',
          name: 'write_file',
          arguments: JSON.stringify({ path: 'tool-created.txt', content: 'created by tool\n' }),
        },
      };
      yield {
        type: 'block-end',
        index: 2,
        block: {
          type: 'tool-call',
          id: 'tc-b1',
          name: 'bash',
          arguments: JSON.stringify({
            command:
              'node -e "const fs=require(\'fs\');fs.mkdirSync(\'gen/nested\',{recursive:true});fs.writeFileSync(\'gen/nested/out.txt\',\'from bash\');fs.writeFileSync(\'user-clobbered-dirty.txt\',\'clobbered!\');fs.writeFileSync(\'gen/bin.dat\',Buffer.from([0,255,1,2,3]));"',
          }),
        },
      };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
    } else {
      yield { type: 'text-delta', index: 0, text: 'all edits complete' };
      yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 5 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  });

  // Replace runtime adapter via second setup sharing same workspace
  await directAgent.close();
  const dataDir2 = realpathSync(mkdtempSync(join(tmpdir(), 'agent-us-30-snapgit2-')));
  t.after(() => rmDirSafe(dataDir2));
  const store2 = new Store(join(dataDir2, 'engine.sqlite'));
  const pool2 = new AccountPool(store2, { root: dataDir2 });
  pool2.setDefaultModel('mock-30');
  const da2 = new DirectAgentRuntime(store2, pool2, {
    defaultWorkspace: workDir,
    dataRoot: dataDir2,
    adapter: scripted,
  });
  const token2 = randomUUID();
  const app2 = api(store2, token2, { models: [], list: () => [] }, { pool: pool2, directAgent: da2 });
  t.after(async () => {
    await da2.close();
    await app2.close();
    store2.close();
  });
  const req2 = (method, url, payload) =>
    app2.inject({ method, url, payload, headers: { authorization: `Bearer ${token2}` } });

  const sessRes = await req2('POST', '/v1/sessions', { permissionMode: 'full-access' });
  const sid = sessRes.json().id;

  const turnRes = await req2('POST', `/v1/sessions/${sid}/turns`, { input: 'modify files and run bash' });
  assert.equal(turnRes.statusCode, 200);
  const t1Id = turnRes.json().turn.id;
  const completedTurn = await waitTurnTerminal(da2, sid, t1Id);
  assert.equal(completedTurn.state, 'completed');

  // Verify bash mutations took place
  assert.equal(readFileSync(join(workDir, 'gen/nested/out.txt'), 'utf8'), 'from bash');
  assert.equal(readFileSync(join(workDir, 'user-clobbered-dirty.txt'), 'utf8'), 'clobbered!');
  assert.equal(readFileSync(join(workDir, 'committed.js'), 'utf8'), 'export const c = 2;\n');

  // 1. Snapshot listing before rewind
  const snapsBefore = (await req2('GET', `/v1/sessions/${sid}/snapshots`)).json();
  assert.equal(snapsBefore.canRedo, false);
  assert.equal(snapsBefore.latestRedoId, null);
  assert.equal(snapsBefore.turns.length, 1);
  assert.equal(snapsBefore.turns[0].hasBaseline, true);

  // 2. Reject 409 SESSION_RUNNING when session is running
  store2.db.prepare("UPDATE direct_sessions SET state='running' WHERE id=?").run(sid);
  const runningRewind = await req2('POST', `/v1/sessions/${sid}/rewind`, { turnId: t1Id, scope: 'files' });
  assert.equal(runningRewind.statusCode, 409);
  assert.equal(runningRewind.json().error.code, 'SESSION_RUNNING');
  store2.db.prepare("UPDATE direct_sessions SET state='completed' WHERE id=?").run(sid);

  // 3. Rewind files-only (`scope: 'files'`)
  const rewindRes = await req2('POST', `/v1/sessions/${sid}/rewind`, { turnId: t1Id, scope: 'files' });
  assert.equal(rewindRes.statusCode, 200);
  const rw = rewindRes.json();
  assert.equal(rw.ok, true);
  assert.equal(rw.scope, 'files');
  assert.equal(rw.removedMessages, 0);
  assert.ok(rw.redoId);
  assert.ok(rw.restoredFiles.includes('committed.js'));
  assert.ok(rw.restoredFiles.includes('user-clobbered-dirty.txt'));
  assert.ok(rw.deletedFiles.includes('tool-created.txt'));
  assert.ok(rw.deletedFiles.includes('gen/nested/out.txt'));
  assert.ok(rw.deletedFiles.includes('gen/bin.dat'));

  // Untouched user dirty & untracked files MUST be 100% protected & untouched
  assert.equal(readFileSync(join(workDir, 'user-dirty.txt'), 'utf8'), 'user uncommitted edit\n');
  assert.equal(readFileSync(join(workDir, 'user-untracked.txt'), 'utf8'), 'keep me safe\n');
  assert.equal(statSync(join(workDir, 'user-untracked.txt')).mtimeMs, untouchedMtime.getTime());
  assert.equal(readFileSync(join(workDir, 'user-clobbered-dirty.txt'), 'utf8'), 'user dirty v0\n');
  assert.equal(readFileSync(join(workDir, 'committed.js'), 'utf8'), 'export const c = 1;\n');
  assert.equal(existsSync(join(workDir, 'tool-created.txt')), false);
  assert.equal(existsSync(join(workDir, 'gen/nested/out.txt')), false);
  assert.equal(existsSync(join(workDir, 'gen')), false, 'newly created empty parent dirs must be pruned');
  assert.equal(existsSync(join(workDir, 'existing-empty-dir')), true, 'pre-existing empty dirs must stay intact');

  // Conversation messages preserved on `scope: 'files'`
  assert.ok(da2.listMessages(sid).length >= 2);

  // Verify persisted session/rewound event
  const rewEv = da2.listEvents(sid).find((e) => e.type === 'session/rewound');
  assert.ok(rewEv);
  assert.equal(rewEv.data.redoId, rw.redoId);

  // Verify binary blob was stored with `base64:` prefix in SQLite blobs table
  const binaryBlobs = store2.db.prepare("SELECT content FROM blobs WHERE content LIKE 'base64:%'").all();
  assert.ok(binaryBlobs.length >= 1, 'binary file must be encoded with base64: in blobs');

  // 4. Instant <10ms Redo (`POST /v1/sessions/:id/rewind/redo`) restores binary + text files
  const snapsCanRedo = (await req2('GET', `/v1/sessions/${sid}/snapshots`)).json();
  assert.equal(snapsCanRedo.canRedo, true);
  assert.equal(snapsCanRedo.latestRedoId, rw.redoId);

  const callsBeforeRedo = scripted.calls;
  const redoRes = await req2('POST', `/v1/sessions/${sid}/rewind/redo`, { redoId: rw.redoId });
  assert.equal(redoRes.statusCode, 200);
  const rd = redoRes.json();
  assert.equal(rd.ok, true);
  assert.equal(rd.redoId, rw.redoId);
  assert.equal(scripted.calls, callsBeforeRedo, 'redo must be zero-token (no LLM call)');
  assert.ok(rd.durationMs < 50, `expected sub-50ms redo, got ${rd.durationMs}ms`);
  assert.equal(readFileSync(join(workDir, 'committed.js'), 'utf8'), 'export const c = 2;\n');
  assert.equal(readFileSync(join(workDir, 'gen/nested/out.txt'), 'utf8'), 'from bash');
  assert.deepEqual([...readFileSync(join(workDir, 'gen/bin.dat'))], [0, 255, 1, 2, 3]);

  const redoEv = da2.listEvents(sid).find((e) => e.type === 'session/rewind_redone');
  assert.ok(redoEv);

  // 5. Single-file revert (`POST /v1/sessions/:id/rewind/file`) + Redo
  const singleRes = await req2('POST', `/v1/sessions/${sid}/rewind/file`, { path: 'committed.js', turnId: t1Id });
  assert.equal(singleRes.statusCode, 200);
  const sf = singleRes.json();
  assert.equal(sf.ok, true);
  assert.equal(sf.path, 'committed.js');
  assert.equal(sf.action, 'restored');
  assert.equal(readFileSync(join(workDir, 'committed.js'), 'utf8'), 'export const c = 1;\n');
  assert.equal(readFileSync(join(workDir, 'gen/nested/out.txt'), 'utf8'), 'from bash', 'other files untouched');

  const revertedEv = da2.listEvents(sid).find((e) => e.type === 'file/reverted');
  assert.ok(revertedEv);
  assert.equal(revertedEv.data.path, 'committed.js');

  const redoSingleRes = await req2('POST', `/v1/sessions/${sid}/rewind/redo`, {});
  assert.equal(redoSingleRes.statusCode, 200);
  assert.equal(readFileSync(join(workDir, 'committed.js'), 'utf8'), 'export const c = 2;\n');

  // 6. Full `scope: 'both'` truncates turns/messages/snapshots + Redo restores them too!
  const bothRes = await req2('POST', `/v1/sessions/${sid}/rewind`, { turnId: t1Id, scope: 'both' });
  assert.equal(bothRes.statusCode, 200);
  assert.ok(bothRes.json().removedMessages > 0);
  assert.equal(da2.listMessages(sid).length, 0);
  assert.equal(da2.listTurns(sid).length, 0);
  assert.equal(existsSync(join(workDir, 'gen/bin.dat')), false);

  const redoBoth = await req2('POST', `/v1/sessions/${sid}/rewind/redo`, {});
  assert.equal(redoBoth.statusCode, 200);
  assert.ok(da2.listMessages(sid).length > 0);
  assert.equal(da2.listTurns(sid).length, 1);
  assert.deepEqual([...readFileSync(join(workDir, 'gen/bin.dat'))], [0, 255, 1, 2, 3]);

  assert.ok(store, 'keep initial store reference used');
  assert.ok(req, 'keep initial req reference used');
});

test('WorkspaceRewindManager handles non-git workspaces, partial paths filter, binary files, and mode preservation', async (t) => {
  const { workDir, store, directAgent } = await setupEnv(t, { initGit: false });
  const mgr = new WorkspaceRewindManager({ store, directAgent, eventRouter: directAgent.eventRouter });

  const binPath = join(workDir, 'img.bin');
  const scriptPath = join(workDir, 'run.sh');
  const untouchedPath = join(workDir, 'keep.txt');
  writeFileSync(binPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xde, 0xad, 0xbe, 0xef]));
  writeFileSync(scriptPath, '#!/bin/sh\necho v1\n', 'utf8');
  if (process.platform !== 'win32') chmodSync(scriptPath, 0o755);
  const expectedMode = statSync(scriptPath).mode & 0o777;
  writeFileSync(untouchedPath, 'stay\n', 'utf8');

  const session = directAgent.createSession({ workspaceRoot: workDir });
  const { turn } = directAgent.startTurn(session.id, { input: 'turn 1' });
  await waitTurnTerminal(directAgent, session.id, turn.id);

  await mgr.captureTurnBaseline(session.id, turn.id, workDir);

  // Mutate binary, script mode/content, and add temp file
  writeFileSync(binPath, Buffer.from([1, 2, 3]));
  writeFileSync(scriptPath, '#!/bin/sh\necho v2\n', 'utf8');
  if (process.platform !== 'win32') chmodSync(scriptPath, 0o644);
  mkdirSync(join(workDir, 'tempdir'), { recursive: true });
  writeFileSync(join(workDir, 'tempdir', 'junk.txt'), 'junk', 'utf8');

  // Partial paths filter: only rewind img.bin
  const partial = await mgr.rewindSession(session.id, {
    turnId: turn.id,
    scope: 'code',
    paths: ['img.bin'],
  });
  assert.deepEqual(partial.restoredFiles, ['img.bin']);
  assert.deepEqual(partial.deletedFiles, []);
  assert.deepEqual([...readFileSync(binPath)], [0x89, 0x50, 0x4e, 0x47, 0x00, 0xde, 0xad, 0xbe, 0xef]);
  assert.equal(readFileSync(scriptPath, 'utf8'), '#!/bin/sh\necho v2\n');

  // Rewind remaining files
  const full = await mgr.rewindSession(session.id, { turnId: turn.id, scope: 'files' });
  assert.ok(full.restoredFiles.includes('run.sh'));
  assert.ok(full.deletedFiles.includes('tempdir/junk.txt'));
  assert.equal(readFileSync(scriptPath, 'utf8'), '#!/bin/sh\necho v1\n');
  assert.equal(statSync(scriptPath).mode & 0o777, expectedMode);
  assert.equal(existsSync(join(workDir, 'tempdir')), false);
  assert.equal(readFileSync(untouchedPath, 'utf8'), 'stay\n');
});

test('Native Git Delivery Loop: changes, path confinement, sensitive/secret guard, unborn HEAD unstage/commit, identity fallback, fork merge & conflict abort', async (t) => {
  const { root, workDir, req } = await setupEnv(t, { initGit: false });

  // 1. Non-git workspace returns available: false
  const nonGitChanges = (await req('GET', '/v1/git/changes')).json();
  assert.equal(nonGitChanges.available, false);
  assert.equal(nonGitChanges.clean, true);

  // Initialize git repo WITHOUT setting repo user.name / user.email (test fallback!)
  await runGit(workDir, ['init', '-b', 'main']);
  const sess = (await req('POST', '/v1/sessions', { workspaceRoot: workDir })).json();

  // Create normal files + sensitive files + .env.example
  writeFileSync(join(workDir, 'app.js'), 'export const x = 1;\n', 'utf8');
  writeFileSync(join(workDir, '.env.example'), 'API_KEY=changeme\n', 'utf8');
  writeFileSync(join(workDir, '.env'), 'SECRET=123\n', 'utf8');
  writeFileSync(join(workDir, '.pool-key'), 'poolsecret\n', 'utf8');
  writeFileSync(join(workDir, '.dev-token'), 'devtok\n', 'utf8');
  writeFileSync(join(workDir, '.provider-env.json'), '{}', 'utf8');
  writeFileSync(join(workDir, 'cert.pem'), 'pem', 'utf8');
  writeFileSync(join(workDir, 'priv.key'), 'key', 'utf8');
  writeFileSync(join(workDir, 'id_rsa'), 'rsa', 'utf8');
  writeFileSync(join(workDir, 'id_rsa.pub'), 'pub', 'utf8');

  // GET /v1/git/changes reports blockedSensitive
  const ch0 = (await req('GET', `/v1/git/changes?sessionId=${sess.id}`)).json();
  assert.equal(ch0.available, true);
  assert.equal(ch0.branch, 'main');
  assert.equal(ch0.headSha, null);
  assert.equal(ch0.clean, false);
  for (const sens of ['.env', '.pool-key', '.dev-token', '.provider-env.json', 'cert.pem', 'priv.key', 'id_rsa', 'id_rsa.pub']) {
    assert.ok(ch0.blockedSensitive.includes(sens), `expected ${sens} in blockedSensitive`);
  }
  assert.ok(!ch0.blockedSensitive.includes('.env.example'), '.env.example must be allowed');

  // Path confinement rejects .. and .git/ and symlink escape
  for (const badPath of ['../outside.txt', '.git/config', 'sub/../../etc/passwd']) {
    const badRes = await req('POST', '/v1/git/stage', { sessionId: sess.id, paths: [badPath] });
    assert.equal(badRes.statusCode, 400);
    assert.equal(badRes.json().error.code, 'GIT_INVALID_PATH');
  }
  const outsideTarget = join(root, 'outside.txt');
  writeFileSync(outsideTarget, 'outside', 'utf8');
  let hasEscapeSymlink = false;
  try {
    symlinkSync(outsideTarget, join(workDir, 'escape-link.txt'));
    hasEscapeSymlink = true;
  } catch (err) {
    // Symlink creation may require Developer Mode on some Windows hosts
    if (!['EPERM', 'EACCES'].includes(err?.code)) throw err;
  }
  if (hasEscapeSymlink) {
    const symRes = await req('POST', '/v1/git/stage', { sessionId: sess.id, paths: ['escape-link.txt'] });
    assert.equal(symRes.statusCode, 400);
    assert.equal(symRes.json().error.code, 'GIT_INVALID_PATH');
  }

  // Sensitive file block on explicit stage
  for (const sens of ['.env', '.pool-key', '.dev-token', '.provider-env.json', 'cert.pem', 'priv.key', 'id_rsa']) {
    const blk = await req('POST', '/v1/git/stage', { sessionId: sess.id, paths: [sens] });
    assert.equal(blk.statusCode, 400, `expected 400 for ${sens}`);
    assert.equal(blk.json().error.code, 'GIT_SENSITIVE_FILE_BLOCKED');
  }

  // Stage all safe files (excludes sensitive files and escaping symlinks, includes app.js & .env.example!)
  const stAll = await req('POST', '/v1/git/stage', { sessionId: sess.id, all: true });
  assert.equal(stAll.statusCode, 200);
  const stagedPaths = stAll.json().staged.map((s) => s.path);
  assert.ok(stagedPaths.includes('app.js'));
  assert.ok(stagedPaths.includes('.env.example'));
  assert.ok(!stagedPaths.includes('.env'));
  assert.ok(!stagedPaths.includes('.pool-key'));
  if (hasEscapeSymlink) {
    assert.ok(!stagedPaths.includes('escape-link.txt'), 'stage all must exclude escaping symlink');
  }

  // Unstage on unborn HEAD (`git rm --cached --`)
  const unstageRes = await req('POST', '/v1/git/unstage', { sessionId: sess.id, paths: ['.env.example'] });
  assert.equal(unstageRes.statusCode, 200);
  assert.ok(!unstageRes.json().staged.some((s) => s.path === '.env.example'));
  assert.ok(existsSync(join(workDir, '.env.example')), 'unstage must keep file in working tree');

  // Commit on unborn HEAD (with fallback identity if global identity is unset)
  const commit1 = await req('POST', '/v1/git/commit', { sessionId: sess.id, message: 'feat: initial safe commit' });
  assert.equal(commit1.statusCode, 200, commit1.body);
  const c1 = commit1.json();
  assert.equal(c1.ok, true);
  assert.ok(c1.commitSha && c1.commitSha.length === 40);
  assert.equal(c1.shortSha, c1.commitSha.slice(0, 7));
  assert.equal(c1.branch, 'main');
  assert.equal(c1.subject, 'feat: initial safe commit');
  assert.deepEqual(c1.filesCommitted, ['app.js']);

  // Secret token guard on staged diff (`sk-...`, `ghp_...`, `BEGIN RSA PRIVATE KEY`)
  const fakeSk = 'sk-' + 'proj-TestSecretToken1234567890';
  const fakeGh = 'ghp_' + 'AbCdEfGhIjKlMnOpQrStUvWx1234';
  const fakePem = '-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAL\n-----END RSA PRIVATE KEY-----';

  for (const [idx, secretBody] of [fakeSk, fakeGh, fakePem].entries()) {
    writeFileSync(join(workDir, 'leak.txt'), `token=${secretBody}\n`, 'utf8');
    const stLeak = await req('POST', '/v1/git/stage', { sessionId: sess.id, paths: ['leak.txt'] });
    assert.equal(stLeak.statusCode, 200);
    const badCommit = await req('POST', '/v1/git/commit', { sessionId: sess.id, message: `leak ${idx}` });
    assert.equal(badCommit.statusCode, 400);
    assert.equal(badCommit.json().error.code, 'GIT_SECRET_DETECTED');
    assert.ok(!badCommit.body.includes(secretBody), 'error payload must never leak secret token');
  }
  await req('POST', '/v1/git/unstage', { sessionId: sess.id, all: true });

  // Clean commit on branch & worktree fork merge
  writeFileSync(join(workDir, 'leak.txt'), 'clean=true\n', 'utf8');
  await req('POST', '/v1/git/stage', { sessionId: sess.id, paths: ['leak.txt'] });
  const c2 = await req('POST', '/v1/git/commit', { sessionId: sess.id, message: 'chore: clean file' });
  assert.equal(c2.statusCode, 200);

  // Fork session into new-worktree, make a commit in the fork worktree, merge via sourceSessionId
  const forkRes = await req('POST', `/v1/sessions/${sess.id}/fork`, { workspaceMode: 'new-worktree' });
  assert.equal(forkRes.statusCode, 200, forkRes.body);
  const forkSess = forkRes.json();

  writeFileSync(join(forkSess.workspaceRoot, 'fork-feature.js'), 'export const forked = true;\n', 'utf8');
  await req('POST', '/v1/git/stage', { sessionId: forkSess.id, paths: ['fork-feature.js'] });
  const forkCommit = await req('POST', '/v1/git/commit', { sessionId: forkSess.id, message: 'feat: worktree feature' });
  assert.equal(forkCommit.statusCode, 200);

  const mergeOk = await req('POST', '/v1/git/merge', {
    sessionId: sess.id,
    sourceSessionId: forkSess.id,
    noFf: true,
    message: 'merge fork feature',
  });
  assert.equal(mergeOk.statusCode, 200, mergeOk.body);
  assert.equal(mergeOk.json().ok, true);
  assert.equal(readFileSync(join(workDir, 'fork-feature.js'), 'utf8').replace(/\r\n/g, '\n'), 'export const forked = true;\n');

  // Verify partial-path commit while another file stays unstaged, plus unstage on normal HEAD
  writeFileSync(join(workDir, 'partial-a.js'), 'export const a = 1;\n', 'utf8');
  writeFileSync(join(workDir, 'partial-b.js'), 'export const b = 1;\n', 'utf8');
  await req('POST', '/v1/git/stage', { sessionId: sess.id, paths: ['partial-b.js'] });
  const partialCommit = await req('POST', '/v1/git/commit', {
    sessionId: sess.id,
    message: 'feat: commit only partial-a',
    paths: ['partial-a.js'],
  });
  assert.equal(partialCommit.statusCode, 200, partialCommit.body);
  assert.deepEqual(partialCommit.json().filesCommitted, ['partial-a.js']);
  // partial-b.js should still be staged!
  assert.ok(partialCommit.json().changes.staged.some((s) => s.path === 'partial-b.js'));
  const unstageNormal = await req('POST', '/v1/git/unstage', { sessionId: sess.id, paths: ['partial-b.js'] });
  assert.equal(unstageNormal.statusCode, 200);
  assert.ok(!unstageNormal.json().staged.some((s) => s.path === 'partial-b.js'));

  // Verify fallback identity ONLY when repo/global identity is unset
  const prevGlobalCfg = process.env.GIT_CONFIG_GLOBAL;
  const prevSystemCfg = process.env.GIT_CONFIG_SYSTEM;
  try {
    const emptyCfg = join(root, 'empty.gitconfig');
    writeFileSync(emptyCfg, '', 'utf8');
    process.env.GIT_CONFIG_GLOBAL = emptyCfg;
    process.env.GIT_CONFIG_SYSTEM = emptyCfg;
    const idRepo = join(root, 'no-id-repo');
    mkdirSync(idRepo, { recursive: true });
    await runGit(idRepo, ['init', '-b', 'main']);
    writeFileSync(join(idRepo, 'hello.txt'), 'hi\n', 'utf8');
    const idSess = (await req('POST', '/v1/sessions', { workspaceRoot: idRepo })).json();
    await req('POST', '/v1/git/stage', { sessionId: idSess.id, paths: ['hello.txt'] });
    const fbCommit = await req('POST', '/v1/git/commit', { sessionId: idSess.id, message: 'fallback id commit' });
    assert.equal(fbCommit.statusCode, 200, fbCommit.body);
    const authorLine = (await runGit(idRepo, ['log', '-1', '--format=%an <%ae>'])).stdout;
    assert.equal(authorLine, 'Agent_US User <agent-us@local>');

    // When repo identity IS set, preserve it rather than overriding
    await runGit(idRepo, ['config', 'user.name', 'Repo Custom']);
    await runGit(idRepo, ['config', 'user.email', 'custom@repo.local']);
    writeFileSync(join(idRepo, 'hello.txt'), 'hi2\n', 'utf8');
    await req('POST', '/v1/git/stage', { sessionId: idSess.id, paths: ['hello.txt'] });
    const customCommit = await req('POST', '/v1/git/commit', { sessionId: idSess.id, message: 'custom id commit' });
    assert.equal(customCommit.statusCode, 200);
    const customAuthor = (await runGit(idRepo, ['log', '-1', '--format=%an <%ae>'])).stdout;
    assert.equal(customAuthor, 'Repo Custom <custom@repo.local>');
  } finally {
    if (prevGlobalCfg === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = prevGlobalCfg;
    if (prevSystemCfg === undefined) delete process.env.GIT_CONFIG_SYSTEM;
    else process.env.GIT_CONFIG_SYSTEM = prevSystemCfg;
  }

  // Conflicting local branch merge -> clean abort + 409 GIT_MERGE_CONFLICT with { conflicts }
  await runGit(workDir, ['checkout', '-b', 'conflict-branch']);
  writeFileSync(join(workDir, 'app.js'), 'export const x = "theirs";\n', 'utf8');
  await req('POST', '/v1/git/stage', { sessionId: sess.id, paths: ['app.js'] });
  await req('POST', '/v1/git/commit', { sessionId: sess.id, message: 'theirs change' });

  await runGit(workDir, ['checkout', 'main']);
  writeFileSync(join(workDir, 'app.js'), 'export const x = "ours";\n', 'utf8');
  await req('POST', '/v1/git/stage', { sessionId: sess.id, paths: ['app.js'] });
  await req('POST', '/v1/git/commit', { sessionId: sess.id, message: 'ours change' });

  const conflictRes = await req('POST', '/v1/git/merge', {
    sessionId: sess.id,
    sourceBranch: 'conflict-branch',
  });
  assert.equal(conflictRes.statusCode, 409);
  const conflictJson = conflictRes.json();
  assert.equal(conflictJson.error.code, 'GIT_MERGE_CONFLICT');
  assert.deepEqual(conflictJson.conflicts, ['app.js']);
  assert.equal(existsSync(join(workDir, '.git/MERGE_HEAD')), false, 'conflict merge must abort cleanly');
  assert.equal(readFileSync(join(workDir, 'app.js'), 'utf8').replace(/\r\n/g, '\n'), 'export const x = "ours";\n');
});

test('Cross-module route hooks: onboarding detect/import, workspace customizations, and steer files forwarding', async (t) => {
  const { workDir, directAgent, req } = await setupEnv(t, { initGit: false });

  // 1. Default fallbacks when runtime hooks are absent
  directAgent.detectExternalConfigs = undefined;
  directAgent.importExternalConfigs = undefined;
  directAgent.getWorkspaceCustomizations = undefined;
  const d0 = await req('GET', '/v1/onboarding/detect-external');
  assert.equal(d0.statusCode, 200);
  assert.equal(d0.json().promptNeeded, false);
  assert.deepEqual(d0.json().items, []);

  const i0 = await req('POST', '/v1/onboarding/import-external', { action: 'skip' });
  assert.equal(i0.statusCode, 200);
  assert.equal(i0.json().ok, true);
  assert.equal(i0.json().action, 'skip');

  const c0 = await req('GET', '/v1/workspace/customizations');
  assert.equal(c0.statusCode, 200);
  assert.equal(c0.json().workspaceRoot, workDir);
  assert.deepEqual(c0.json().commands, []);

  // 2. Delegation when methods exist on directAgent
  const calls = [];
  directAgent.detectExternalConfigs = async (opts) => {
    calls.push(['detect', opts]);
    return {
      promptNeeded: true,
      counts: { rules: 1, commands: 1, skills: 0, agents: 0, mcp: 0, total: 2 },
      providers: ['claude'],
      items: [{ id: 'rule:1', provider: 'claude', scope: 'user', kind: 'rule', name: 'CLAUDE.md' }],
    };
  };
  directAgent.importExternalConfigs = async (opts) => {
    calls.push(['import', opts]);
    return { ok: true, action: opts.action, importedCount: 1, promptNeeded: false };
  };
  directAgent.getWorkspaceCustomizations = async (ws) => {
    calls.push(['customizations', ws]);
    return { workspaceRoot: ws, commands: [{ name: 'deploy' }], agents: [], skills: [], rules: [], mcpServers: [] };
  };

  const sess = (await req('POST', '/v1/sessions', {})).json();

  const d1 = await req('GET', `/v1/onboarding/detect-external?sessionId=${sess.id}&force=1`);
  assert.equal(d1.statusCode, 200);
  assert.equal(d1.json().promptNeeded, true);
  assert.equal(calls[0][0], 'detect');
  assert.equal(calls[0][1].workspaceRoot, workDir);
  assert.equal(calls[0][1].force, true);

  const i1 = await req('POST', '/v1/onboarding/import-external', {
    sessionId: sess.id,
    action: 'import',
    itemIds: ['rule:1'],
    targetScope: 'workspace',
  });
  assert.equal(i1.statusCode, 200);
  assert.equal(i1.json().importedCount, 1);
  assert.deepEqual(calls[1][1], {
    workspaceRoot: workDir,
    action: 'import',
    itemIds: ['rule:1'],
    targetScope: 'workspace',
  });

  const c1 = await req('GET', `/v1/workspace/customizations?sessionId=${sess.id}`);
  assert.equal(c1.statusCode, 200);
  assert.equal(c1.json().commands[0].name, 'deploy');

  // 3. POST /v1/sessions/:id/steer forwards { files } as 3rd arg
  let steeredArgs = null;
  directAgent.steerSession = (id, input, opts) => {
    steeredArgs = { id, input, opts };
    return { steered: true, sessionId: id, turnId: 't-steer', queued: 1 };
  };
  const steerRes = await req('POST', `/v1/sessions/${sess.id}/steer`, {
    input: 'check attachment',
    files: { 'note.txt': Buffer.from('hello').toString('base64') },
  });
  assert.equal(steerRes.statusCode, 200);
  assert.deepEqual(steeredArgs, {
    id: sess.id,
    input: 'check attachment',
    opts: { files: { 'note.txt': Buffer.from('hello').toString('base64') } },
  });
});

test('WP6.1: stageGitPaths filters escaping symlinks on all=true while keeping explicit paths strict', async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agent-us-32-stage-symlink-')));
  const outsideDir = join(root, 'outside');
  const repoDir = join(root, 'repo');
  const escapeDirLink = join(repoDir, 'escape-dir-link');
  const escapeFileLink = join(repoDir, 'escape-file-link.txt');
  t.after(() => {
    for (const p of [escapeDirLink, escapeFileLink]) {
      try {
        unlinkSync(p);
      } catch {
        // Ignore if not created
      }
    }
    rmDirSafe(root);
  });

  mkdirSync(outsideDir, { recursive: true });
  mkdirSync(repoDir, { recursive: true });
  writeFileSync(join(outsideDir, 'outside.txt'), 'outside-secret\n', 'utf8');
  writeFileSync(join(repoDir, 'app.js'), 'export const safe = 1;\n', 'utf8');
  writeFileSync(join(repoDir, '.env'), 'SECRET=1\n', 'utf8');

  await runGit(repoDir, ['init', '-b', 'main']);

  symlinkSync(outsideDir, escapeDirLink, process.platform === 'win32' ? 'junction' : 'dir');
  let hasFileSymlink = false;
  try {
    symlinkSync(join(outsideDir, 'outside.txt'), escapeFileLink);
    hasFileSymlink = true;
  } catch (err) {
    if (!['EPERM', 'EACCES'].includes(err?.code)) throw err;
  }

  // Explicit request for an escaping symlink/junction path must reject with GIT_INVALID_PATH
  await assert.rejects(
    () => stageGitPaths(repoDir, { paths: ['escape-dir-link'] }),
    (err) => err?.code === 'GIT_INVALID_PATH',
  );
  if (process.platform === 'win32') {
    await assert.rejects(
      () => stageGitPaths(repoDir, { paths: ['escape-dir-link/outside.txt'] }),
      (err) => err?.code === 'GIT_INVALID_PATH',
    );
  }
  if (hasFileSymlink) {
    await assert.rejects(
      () => stageGitPaths(repoDir, { paths: ['escape-file-link.txt'] }),
      (err) => err?.code === 'GIT_INVALID_PATH',
    );
  }

  // all=true must stage safe files while cleanly skipping escaping links and sensitive files
  const stagedRes = await stageGitPaths(repoDir, { all: true });
  assert.equal(stagedRes.ok, true);
  assert.deepEqual(
    stagedRes.staged.map((s) => s.path),
    ['app.js'],
  );

  // Only sensitive + escaping link remaining -> GIT_SENSITIVE_FILE_BLOCKED (without leaking escape links)
  await runGit(repoDir, ['rm', '-f', '--', 'app.js']);
  await assert.rejects(
    () => stageGitPaths(repoDir, { all: true }),
    (err) =>
      err?.code === 'GIT_SENSITIVE_FILE_BLOCKED' &&
      Array.isArray(err.detail?.blockedSensitive) &&
      err.detail.blockedSensitive.includes('.env') &&
      !err.detail.blockedSensitive.some((p) => p.includes('escape')),
  );

  // Only escaping link remaining -> cleanly skipped with 0 staged files
  unlinkSync(join(repoDir, '.env'));
  const onlyEscapeRes = await stageGitPaths(repoDir, { all: true });
  assert.equal(onlyEscapeRes.ok, true);
  assert.deepEqual(onlyEscapeRes.staged, []);
});
