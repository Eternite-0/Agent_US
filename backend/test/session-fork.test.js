import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Store } from '../src/store.js';
import { DirectSessionRepo } from '../src/runtime/session-repo.js';
import { forkChatSession } from '../src/routes/session-fork.js';
import { rmDirSafe } from './fixtures.js';

const exec = promisify(execFile);
const runGit = async (cwd, args) => exec('git', args, { cwd, windowsHide: true });

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-us-chat-fork-'));
  const workspace = join(dir, 'workspace');
  mkdirSync(workspace);
  const dbPath = join(dir, 'test.sqlite');
  const store = new Store(dbPath);
  const directAgent = new DirectSessionRepo({ store, getWorkspaceRoot: () => workspace, getDefaultModel: () => 'fixture' });
  t.after(() => { store.db.close(); rmDirSafe(dir); });
  return { store, directAgent, runGit, workspace, dbPath };
}

test('chat forks persist inherited text without inheriting replayable tool history or prior approvals', async (t) => {
  const f = fixture(t);
  const source = f.directAgent.createSession({ title: 'Source', permissionMode: 'full-access', toolAllow: ['read_file'] });
  const insert = f.store.db.prepare(`
    INSERT INTO direct_messages (sessionId, role, content, reasoning, meta, createdAt) VALUES (?, ?, ?, ?, ?, ?)
  `);
  insert.run(source.id, 'user', 'How is the application organized?', null, JSON.stringify({ files: { 'notes.txt': 'dGVzdA==' } }), 1);
  insert.run(source.id, 'tool', 'private command output', null, null, 2);
  insert.run(source.id, 'assistant', 'Three modules.', 'private thinking', null, 3);

  const fork = await forkChatSession(f, source.id, 'same-workspace');
  assert.notEqual(fork.id, source.id);
  assert.equal(fork.workspaceRoot, source.workspaceRoot);
  assert.equal(fork.permissionMode, 'approval');
  assert.deepEqual(fork.toolAllow, ['read_file']);
  assert.equal(f.directAgent.listTurns(fork.id).length, 0);

  const reopened = new Store(f.dbPath);
  try {
    assert.equal(reopened.db.prepare('SELECT state FROM direct_sessions WHERE id=?').get(fork.id).state, 'idle');
    const rows = reopened.db.prepare('SELECT role, content, reasoning, meta FROM direct_messages WHERE sessionId=? ORDER BY seq').all(fork.id);
    assert.deepEqual(rows.map(({ role, content }) => ({ role, content })), [
      { role: 'user', content: 'How is the application organized?' },
      { role: 'assistant', content: 'Three modules.' },
    ]);
    assert.ok(rows.every(({ reasoning, meta }) => reasoning === null && JSON.parse(meta).inheritedFromSessionId === source.id));
  } finally {
    reopened.db.close();
  }
});

test('a new worktree fork starts from HEAD and leaves the source branch and dirty file intact', async (t) => {
  const f = fixture(t);
  await runGit(f.workspace, ['init', '-q', '-b', 'main']);
  await runGit(f.workspace, ['config', 'user.name', 'Agent US Test']);
  await runGit(f.workspace, ['config', 'user.email', 'agent-us-test@example.invalid']);
  const file = join(f.workspace, 'readme.txt');
  writeFileSync(file, 'committed');
  await runGit(f.workspace, ['add', 'readme.txt']);
  await runGit(f.workspace, ['commit', '-qm', 'Initial commit']);
  writeFileSync(file, 'dirty');

  const source = f.directAgent.createSession();
  const fork = await forkChatSession(f, source.id, 'new-worktree');
  assert.equal(readFileSync(file, 'utf8'), 'dirty');
  assert.equal(readFileSync(join(fork.workspaceRoot, 'readme.txt'), 'utf8'), 'committed');
  assert.equal((await runGit(f.workspace, ['branch', '--show-current'])).stdout.trim(), 'main');
  assert.equal((await runGit(fork.workspaceRoot, ['branch', '--show-current'])).stdout.trim(), `agent-us/chat-${fork.id}`);
});

test('rejects invalid workspace modes and running or synthetic chats', async (t) => {
  const f = fixture(t);
  const source = f.directAgent.createSession();
  const synthetic = f.directAgent.createSession({ trafficSource: 'evaluation', isSynthetic: true });
  await assert.rejects(forkChatSession(f, source.id, '../other'), { code: 'INVALID_FORK_WORKSPACE_MODE' });
  await assert.rejects(forkChatSession(f, synthetic.id, 'same-workspace'), { code: 'CHAT_FORK_UNAVAILABLE' });
  f.store.db.prepare("UPDATE direct_sessions SET state='running' WHERE id=?").run(source.id);
  await assert.rejects(forkChatSession(f, source.id, 'same-workspace'), { code: 'CHAT_FORK_RUNNING' });
});
