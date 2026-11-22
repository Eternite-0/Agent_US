import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Fault, id } from '../store.js';
import { redactSecrets } from '../envelope.js';

export async function forkChatSession({ store, directAgent, runGit }, sourceId, workspaceMode) {
  if (workspaceMode !== 'same-workspace' && workspaceMode !== 'new-worktree') {
    throw new Fault('INVALID_FORK_WORKSPACE_MODE', 400);
  }
  const readSource = () => {
    const session = directAgent.getSession(sourceId);
    if (session.parentSessionId || session.isSynthetic) throw new Fault('CHAT_FORK_UNAVAILABLE', 409);
    if (session.state === 'running') throw new Fault('CHAT_FORK_RUNNING', 409);
    return session;
  };
  const source = readSource();
  const forkId = id();
  const branch = `agent-us/chat-${forkId}`;
  let worktree = null;
  if (workspaceMode === 'new-worktree') {
    if (store.dbPath === ':memory:' || !source.workspaceRoot) throw new Fault('CHAT_WORKTREE_UNAVAILABLE', 409);
    const directory = join(dirname(store.dbPath), 'chat-worktrees');
    await mkdir(directory, { recursive: true });
    worktree = join(directory, forkId);
    try {
      // Start at the committed revision without switching or copying the source worktree.
      await runGit(source.workspaceRoot, ['worktree', 'add', '-b', branch, worktree, 'HEAD']);
    } catch {
      throw new Fault('CHAT_WORKTREE_CREATION_FAILED', 409);
    }
  }
  try {
    return store.tx(() => {
      const latest = readSource();
      const fork = directAgent.createSession({
        id: forkId,
        title: `分支 · ${latest.title}`,
        workspaceRoot: worktree ?? latest.workspaceRoot,
        model: latest.model,
        mode: latest.mode,
        permissionMode: 'approval',
        budget: latest.budget,
        toolAllow: latest.toolAllow,
        toolDeny: latest.toolDeny,
        trafficSource: latest.trafficSource,
        isSynthetic: false,
      });
      // Keep inherited text separate from turns, tool executions, receipts and usage in the fork.
      const rows = store.db.prepare(`
        SELECT role, content, createdAt FROM direct_messages
         WHERE sessionId = ? AND role IN ('user', 'assistant') AND length(trim(content)) > 0
         ORDER BY seq DESC LIMIT 60
      `).all(sourceId).reverse();
      const insert = store.db.prepare(`
        INSERT INTO direct_messages(sessionId, role, content, meta, createdAt) VALUES(?, ?, ?, ?, ?)
      `);
      const meta = JSON.stringify({ inheritedFromSessionId: sourceId });
      for (const row of rows) insert.run(forkId, row.role, redactSecrets(row.content.slice(0, 8000)), meta, row.createdAt);
      return fork;
    });
  } catch (error) {
    if (worktree) {
      try {
        await runGit(source.workspaceRoot, ['worktree', 'remove', worktree]);
        await runGit(source.workspaceRoot, ['branch', '-d', branch]);
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Failed to roll back chat worktree');
      }
    }
    throw error;
  }
}
