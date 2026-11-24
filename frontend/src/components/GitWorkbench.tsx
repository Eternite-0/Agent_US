import React, { useCallback, useEffect, useState } from 'react';
import type { AgentBackendClient } from '../api/client';
import type { GitChangeEntry, GitChangesResponse } from '../types/backend';
import { IconBranch, IconCheck, IconFileDoc, IconRefresh, IconShieldAlert } from './Icons';

interface GitWorkbenchProps {
  client: AgentBackendClient;
  sessionId: string | null;
  open: boolean;
  initialChanges?: GitChangesResponse | null;
  onInspectFile?: (path: string) => void;
  onRefreshGitStatus?: () => Promise<void> | void;
  onToast: (msg: string, tone?: 'default' | 'success' | 'warning' | 'danger') => void;
}

export const GitWorkbench: React.FC<GitWorkbenchProps> = ({
  client,
  sessionId,
  open,
  initialChanges = null,
  onInspectFile,
  onRefreshGitStatus,
  onToast,
}) => {
  const [changes, setChanges] = useState<GitChangesResponse | null>(initialChanges);
  const [loading, setLoading] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [commitMessage, setCommitMessage] = useState('');
  const [errorMsg, setErrorMsg] = useState('');

  const refreshChanges = useCallback(async () => {
    if (!client.getGitChanges) {
      setChanges({ available: false, branch: null, staged: [], unstaged: [], untracked: [], blockedSensitive: [] });
      return;
    }
    setLoading(true);
    try {
      const next = await client.getGitChanges(sessionId ?? undefined);
      setChanges(next);
    } catch {
      // Gracefully fall back if endpoint is unavailable in fixture/demo mode
    } finally {
      setLoading(false);
    }
  }, [client, sessionId]);

  useEffect(() => {
    if (!open || initialChanges) return;
    void refreshChanges();
  }, [open, initialChanges, refreshChanges]);

  const handleStage = async (opts: { paths?: string[]; all?: boolean }) => {
    if (!client.stageGitFiles || busyAction) return;
    setBusyAction(opts.all ? 'stage-all' : `stage:${opts.paths?.[0] ?? ''}`);
    setErrorMsg('');
    try {
      const next = await client.stageGitFiles({
        sessionId: sessionId ?? undefined,
        expectedWorkspaceRoot: changes?.workspaceRoot,
        ...opts,
      });
      setChanges(next);
      await onRefreshGitStatus?.();
      if (next.blockedSensitive?.length) {
        onToast(`已拦截敏感文件：${next.blockedSensitive.join(', ')}`, 'warning');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : '暂存失败';
      setErrorMsg(msg);
      onToast(msg, 'danger');
    } finally {
      setBusyAction(null);
    }
  };

  const handleUnstage = async (opts: { paths?: string[]; all?: boolean }) => {
    if (!client.unstageGitFiles || busyAction) return;
    setBusyAction(opts.all ? 'unstage-all' : `unstage:${opts.paths?.[0] ?? ''}`);
    setErrorMsg('');
    try {
      const next = await client.unstageGitFiles({
        sessionId: sessionId ?? undefined,
        expectedWorkspaceRoot: changes?.workspaceRoot,
        ...opts,
      });
      setChanges(next);
      await onRefreshGitStatus?.();
    } catch (err) {
      const msg = err instanceof Error ? err.message : '取消暂存失败';
      setErrorMsg(msg);
      onToast(msg, 'danger');
    } finally {
      setBusyAction(null);
    }
  };

  const handleCommit = async () => {
    const trimmed = commitMessage.trim();
    if (!client.commitGitChanges || !trimmed || busyAction) return;
    setBusyAction('commit');
    setErrorMsg('');
    try {
      const res = await client.commitGitChanges({
        sessionId: sessionId ?? undefined,
        expectedWorkspaceRoot: changes?.workspaceRoot,
        message: trimmed,
      });
      setCommitMessage('');
      if (res.changes) setChanges(res.changes);
      else await refreshChanges();
      await onRefreshGitStatus?.();
      onToast(`已提交 ${res.shortSha || ''}${res.subject ? `: ${res.subject}` : ''}`, 'success');
    } catch (err) {
      const msg = err instanceof Error ? err.message : '提交失败';
      setErrorMsg(msg);
      onToast(msg, 'danger');
    } finally {
      setBusyAction(null);
    }
  };

  const staged = changes?.staged ?? [];
  const unstaged = changes?.unstaged ?? [];
  const untracked = changes?.untracked ?? [];
  const workingEntries: GitChangeEntry[] = [
    ...unstaged,
    ...untracked.map((entry) => ({ ...entry, status: entry.status || '?' })),
  ];
  const blockedSensitive = changes?.blockedSensitive ?? [];
  const canOperate = Boolean(changes?.available && client.stageGitFiles && client.unstageGitFiles && client.commitGitChanges);

  return (
    <div className="codex-drawer-body codex-git-workbench" aria-label="Git 暂存与提交工作台">
      <div className="codex-git-wb-header">
        <div className="codex-git-wb-branch">
          <IconBranch size={14} aria-hidden="true" />
          <strong>{changes?.branch || '无 Git 分支'}</strong>
          {changes?.headSha && <code className="codex-git-wb-sha">{changes.headSha.slice(0, 7)}</code>}
          {(changes?.ahead || changes?.behind) ? (
            <span className="codex-git-wb-sync tabular-nums">
              {changes.ahead ? `↑${changes.ahead}` : ''}
              {changes.behind ? ` ↓${changes.behind}` : ''}
            </span>
          ) : null}
        </div>
        <button
          type="button"
          className="codex-toolbar-btn"
          data-variant="outline"
          disabled={loading || Boolean(busyAction)}
          onClick={() => void refreshChanges()}
        >
          <IconRefresh size={12} aria-hidden="true" />
          <span>{loading ? '刷新中…' : '刷新'}</span>
        </button>
      </div>

      {blockedSensitive.length > 0 && (
        <div className="codex-git-sensitive-notice" role="status">
          <IconShieldAlert size={14} aria-hidden="true" />
          <span>
            安全守卫已拦截敏感文件，禁止暂存/提交：<code>{blockedSensitive.join(', ')}</code>
          </span>
        </div>
      )}

      {errorMsg && (
        <div className="codex-git-error-notice" role="alert">
          <IconShieldAlert size={14} aria-hidden="true" />
          <span>{errorMsg}</span>
        </div>
      )}

      {!changes?.available ? (
        <div className="codex-git-empty">
          {loading ? '正在读取工作区 Git 变更…' : '当前工作区未检测到可用 Git 仓库，或后端暂未提供 Git 变更接口。'}
        </div>
      ) : (
        <>
          <section className="codex-git-section" aria-label="已暂存变更">
            <div className="codex-git-section-head">
              <span>已暂存 ({staged.length})</span>
              {staged.length > 0 && (
                <button
                  type="button"
                  className="codex-toolbar-btn"
                  data-variant="outline"
                  disabled={!canOperate || Boolean(busyAction)}
                  onClick={() => void handleUnstage({ all: true })}
                >
                  全部取消暂存
                </button>
              )}
            </div>
            {staged.length === 0 ? (
              <div className="codex-git-section-empty">暂无已暂存的文件</div>
            ) : (
              <div className="codex-git-file-list">
                {staged.map((item) => (
                  <div key={`staged:${item.path}`} className="codex-git-file-row">
                    <span className="codex-git-status-badge" data-status={item.status}>{item.status}</span>
                    {onInspectFile ? (
                      <button
                        type="button"
                        className="codex-git-file-path"
                        title={item.path}
                        onClick={() => onInspectFile(item.path)}
                      >
                        <IconFileDoc size={13} aria-hidden="true" />
                        <span>{item.path}</span>
                      </button>
                    ) : (
                      <span className="codex-git-file-path" title={item.path}>
                        <IconFileDoc size={13} aria-hidden="true" />
                        <span>{item.path}</span>
                      </span>
                    )}
                    <button
                      type="button"
                      className="codex-toolbar-btn"
                      data-variant="outline"
                      disabled={!canOperate || Boolean(busyAction)}
                      onClick={() => void handleUnstage({ paths: [item.path] })}
                    >
                      取消暂存
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="codex-git-section" aria-label="未暂存变更">
            <div className="codex-git-section-head">
              <span>未暂存与未跟踪 ({workingEntries.length})</span>
              {workingEntries.length > 0 && (
                <button
                  type="button"
                  className="codex-toolbar-btn"
                  data-variant="outline"
                  disabled={!canOperate || Boolean(busyAction)}
                  onClick={() => void handleStage({ all: true })}
                >
                  全部暂存
                </button>
              )}
            </div>
            {workingEntries.length === 0 ? (
              <div className="codex-git-section-empty">工作区无未暂存修改</div>
            ) : (
              <div className="codex-git-file-list">
                {workingEntries.map((item) => (
                  <div key={`work:${item.path}`} className="codex-git-file-row">
                    <span className="codex-git-status-badge" data-status={item.status}>{item.status}</span>
                    {onInspectFile ? (
                      <button
                        type="button"
                        className="codex-git-file-path"
                        title={item.path}
                        onClick={() => onInspectFile(item.path)}
                      >
                        <IconFileDoc size={13} aria-hidden="true" />
                        <span>{item.path}</span>
                      </button>
                    ) : (
                      <span className="codex-git-file-path" title={item.path}>
                        <IconFileDoc size={13} aria-hidden="true" />
                        <span>{item.path}</span>
                      </span>
                    )}
                    <button
                      type="button"
                      className="codex-toolbar-btn"
                      data-variant="outline"
                      disabled={!canOperate || Boolean(busyAction)}
                      onClick={() => void handleStage({ paths: [item.path] })}
                    >
                      暂存
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="codex-git-commit-box" aria-label="提交变更">
            <textarea
              className="codex-git-commit-input"
              aria-label="提交说明"
              rows={3}
              placeholder="输入提交说明 (Commit message)…"
              value={commitMessage}
              disabled={!canOperate || busyAction === 'commit'}
              onChange={(e) => setCommitMessage(e.target.value)}
            />
            <div className="codex-git-commit-actions">
              <span className="codex-git-commit-hint tabular-nums">
                {staged.length > 0 ? `将提交 ${staged.length} 个已暂存文件` : '请先暂存需要提交的文件'}
              </span>
              <button
                type="button"
                className="codex-toolbar-btn"
                data-variant="primary"
                disabled={!canOperate || Boolean(busyAction) || !commitMessage.trim() || staged.length === 0}
                onClick={() => void handleCommit()}
              >
                <IconCheck size={13} aria-hidden="true" />
                <span>{busyAction === 'commit' ? '正在提交…' : '提交'}</span>
              </button>
            </div>
          </section>
        </>
      )}
    </div>
  );
};
