import React, { useCallback, useEffect, useState } from 'react';
import type { AgentBackendClient } from '../api/client';
import type { EvaluationBenchmark, EvaluationRun } from '../types/backend';

interface EvaluationViewProps { client: AgentBackendClient; onToast: (message: string, tone?: 'success' | 'danger' | 'default') => void; }

function statusLabel(status: EvaluationRun['status']): string {
  return ({ queued: '排队中', running: '运行中', completed: '已完成', failed: '失败', cancelled: '已取消', timeout: '超时' } as Record<string, string>)[status] ?? status;
}

export const EvaluationView: React.FC<EvaluationViewProps> = ({ client, onToast }) => {
  const [benchmarks, setBenchmarks] = useState<EvaluationBenchmark[]>([]);
  const [runs, setRuns] = useState<EvaluationRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [nextBenchmarks, nextRuns] = await Promise.all([
        client.listBenchmarks?.() ?? Promise.resolve([]),
        client.listEvaluationRuns?.({ limit: 20 }) ?? Promise.resolve([]),
      ]);
      setBenchmarks(nextBenchmarks);
      setRuns(nextRuns);
    } catch (error) {
      onToast(error instanceof Error ? error.message : '加载评测数据失败', 'danger');
    } finally { setLoading(false); }
  }, [client, onToast]);

  useEffect(() => { void refresh(); }, [refresh]);

  const start = async (benchmark: EvaluationBenchmark) => {
    if (!client.startEvaluation) { onToast('当前后端不支持评测运行', 'danger'); return; }
    setStarting(true);
    try {
      await client.startEvaluation({ benchmarkId: benchmark.id, concurrency: 2, maxAttempts: 1 });
      onToast(`已启动 ${benchmark.title}`, 'success');
      await refresh();
    } catch (error) { onToast(error instanceof Error ? error.message : '启动评测失败', 'danger'); }
    finally { setStarting(false); }
  };

  return <section style={{ width: '100%', maxWidth: 980, margin: '0 auto', padding: '32px 36px' }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
      <div><div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 8 }}>EVALUATION CENTER</div><h1 style={{ margin: 0, fontSize: 28 }}>能力评测</h1><p style={{ color: 'var(--text-secondary)', margin: '8px 0 0' }}>使用确定性 Benchmark 验证 Runtime 的真实交付能力。</p></div>
      <button className="codex-secondary-btn" type="button" onClick={() => void refresh()} disabled={loading}>刷新</button>
    </div>
    {loading ? <div className="codex-empty-state">正在加载评测目录…</div> : <>
      <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit,minmax(260px,1fr))', marginBottom: 28 }}>
        {benchmarks.map((benchmark) => <article key={benchmark.id} className="codex-settings-card" style={{ padding: 18 }}><div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}><div><strong>{benchmark.title}</strong><div style={{ color: 'var(--text-secondary)', fontSize: 13, marginTop: 6 }}>{benchmark.taskCount} 个任务 · v{benchmark.version}</div></div><button className="codex-primary-btn" type="button" disabled={starting} onClick={() => void start(benchmark)}>运行</button></div><div style={{ color: 'var(--text-tertiary)', fontSize: 12, marginTop: 12 }}>{benchmark.categories.join(' · ')}</div></article>)}
      </div>
      <h2 style={{ fontSize: 17, margin: '0 0 12px' }}>最近运行</h2>
      {runs.length === 0 ? <div className="codex-empty-state">暂无评测运行记录</div> : <div style={{ display: 'grid', gap: 8 }}>{runs.map((run) => <div key={run.id} className="codex-list-row" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 14px' }}><div><strong>{statusLabel(run.status)}</strong><div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 4 }}>{run.benchmarkId} · {new Date(run.createdAt).toLocaleString()}</div></div><div style={{ textAlign: 'right', fontSize: 13 }}>{run.score ? `${Math.round(run.score.passRate * 100)}% 通过` : '等待结果'}</div></div>)}</div>}
    </>}
  </section>;
};
