import { useEffect, useState } from 'react';
import type { AgentBackendClient } from '../api/client';
import type { ExperienceMemoryRecord } from '../types/backend';

const typeLabels: Record<string, string> = {
  user: '偏好', project: '项目', episodic: '任务经历', procedural: '工作流程',
  failure: '失败经验', capability: '能力记录', lesson: '经验', decision: '决策', preference: '偏好', pattern: '做法',
};

export function ExperienceMemoryPanel({ client, projectId, onToast }: {
  client: AgentBackendClient;
  projectId?: string;
  onToast: (message: string, tone?: 'success' | 'danger') => void;
}) {
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<ExperienceMemoryRecord[]>();
  const [revision, setRevision] = useState(0);
  const [loadError, setLoadError] = useState(false);
  const [pendingId, setPendingId] = useState<string>();
  const list = client.listExperienceMemory;

  useEffect(() => {
    if (!list || !projectId) return;
    const controller = new AbortController();
    const { signal } = controller;
    setLoadError(false);
    const timer = window.setTimeout(() => {
      void list.call(client, projectId, query.trim(), signal).then((result) => {
        if (!signal.aborted) setItems(result);
      }, () => {
        if (!signal.aborted) setLoadError(true);
      });
    }, 180);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [client, list, projectId, query, revision]);

  if (!list) return null;
  async function remove(item: ExperienceMemoryRecord) {
    if (!projectId || !client.deleteExperienceMemory || pendingId || !window.confirm('从当前工作区删除这条经验记忆？')) return;
    setPendingId(item.id);
    try {
      const result = await client.deleteExperienceMemory(projectId, item.id);
      if (result?.status !== 'deleted') throw new Error('未找到可删除的记忆。');
      setItems((current) => current?.filter((entry) => entry.id !== item.id));
      setRevision((value) => value + 1);
      onToast('已删除经验记忆', 'success');
    } catch (error) {
      onToast(error instanceof Error ? error.message : '删除经验记忆失败。', 'danger');
    } finally {
      setPendingId(undefined);
    }
  }

  return <section className="experience-memory" aria-labelledby="experience-memory-title">
    <h2 id="experience-memory-title">工作区经验</h2>
    {!projectId ? <p className="evaluation-state">选择工作区后可查看任务积累的经验。</p> : <>
      <div className="autonomous-toolbar">
        <input className="codex-input" type="search" aria-label="搜索工作区经验" placeholder="搜索工作区经验" value={query} onChange={(event) => setQuery(event.target.value)} />
        <button type="button" className="codex-toolbar-btn" data-variant="outline" onClick={() => setRevision((value) => value + 1)}>刷新经验</button>
      </div>
      {loadError && <p className="evaluation-state" role="alert">工作区经验加载失败。</p>}
      {!items && !loadError && <p className="evaluation-state" role="status">正在加载工作区经验…</p>}
      {items?.length === 0 && !loadError && <p className="evaluation-state">{query.trim() ? '未找到相关经验。' : '此工作区暂无经验记录。'}</p>}
      {items?.map((item) => <div key={item.id} className="codex-settings-row">
        <div className="codex-settings-row-info">
          <span className="codex-settings-row-label">{item.key || typeLabels[item.type] || item.type}</span>
          <span className="codex-settings-row-desc">{item.verified ? '已验证' : '未验证'} · {typeLabels[item.type] || item.type} · 置信度 {Math.round(item.confidence * 100)}%</span>
          <div className="experience-memory-content">{item.content}</div>
          {item.verified && item.verificationEvidence && <details>
            <summary>查看验证来源</summary>
            {item.verificationEvidence.sourceTaskId && <div>任务 <code>{item.verificationEvidence.sourceTaskId}</code></div>}
            {item.verificationEvidence.evaluationRunId && <div>评测 <code>{item.verificationEvidence.evaluationRunId}</code></div>}
            {item.verificationEvidence.verifiedAt && <div>{new Date(item.verificationEvidence.verifiedAt).toLocaleString()}</div>}
            {item.sourceArtifact && <code>{item.sourceArtifact}</code>}
          </details>}
        </div>
        {client.deleteExperienceMemory && <button type="button" className="codex-toolbar-btn" data-variant="outline"
          aria-label={`删除经验 ${item.key || item.id}`} disabled={Boolean(pendingId)} onClick={() => void remove(item)}>删除</button>}
      </div>)}
    </>}
  </section>;
}
