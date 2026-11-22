import { useEffect, useRef, useState } from 'react';
import type { AgentBackendClient } from '../api/client';
import type { EvaluationBenchmark, EvaluationRun, EvaluationTaskResult, ModelSpec } from '../types/backend';
import { fmtDuration } from '../utils/format';
import { EvaluationComparison } from './EvaluationComparison';
import { ModelCapabilityPanel } from './ModelCapabilityPanel';

interface EvaluationViewProps {
  client: AgentBackendClient;
  models: ModelSpec[];
  onToast: (message: string, tone?: 'success' | 'danger' | 'default') => void;
}

const statusLabels: Record<EvaluationTaskResult['status'], string> = {
  queued: '排队中', running: '运行中', completed: '已完成', passed: '通过',
  failed: '失败', cancelled: '已取消', timeout: '超时',
};
const isActive = (run: EvaluationRun) => run.status === 'queued' || run.status === 'running';

function Status({ run }: { run: EvaluationRun }) {
  return <span className="evaluation-status" data-status={run.status}>
    {run.cancelRequestedAt && isActive(run) ? '正在取消' : statusLabels[run.status]}
  </span>;
}

export function EvaluationView({ client, models, onToast }: EvaluationViewProps) {
  const [benchmarks, setBenchmarks] = useState<EvaluationBenchmark[]>([]);
  const [runs, setRuns] = useState<EvaluationRun[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<EvaluationRun | null>(null);
  const [filter, setFilter] = useState('');
  const [model, setModel] = useState('');
  const [taskSelections, setTaskSelections] = useState<Record<string, string>>({});
  const modelChoices = [...new Set(models.map((item) => item.model))].sort();
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [detailError, setDetailError] = useState(false);
  const [action, setAction] = useState<{ type: 'start' | 'cancel'; id: string } | null>(null);
  const currentClient = useRef(client);
  currentClient.current = client;
  const supported = Boolean(client.listBenchmarks && client.listEvaluationRuns);

  useEffect(() => {
    setBenchmarks([]);
    setRuns([]);
    setSelectedId(null);
    setDetail(null);
    setFilter('');
    setModel('');
    setTaskSelections({});
    setAction(null);
  }, [client]);

  useEffect(() => {
    if (!client.listBenchmarks || !client.listEvaluationRuns) return;
    const controller = new AbortController();
    const signal = controller.signal;
    let timer: number | undefined;
    setLoading(true);
    setLoadError(false);

    async function refresh() {
      const [catalog, history] = await Promise.allSettled([
        client.listBenchmarks!(signal),
        client.listEvaluationRuns!({ benchmarkId: filter || undefined, limit: 40, signal }),
      ]);
      if (signal.aborted) return;
      const failed = catalog.status === 'rejected' || history.status === 'rejected';
      setLoadError(failed);
      if (catalog.status === 'fulfilled') setBenchmarks(catalog.value);
      if (history.status === 'fulfilled') setRuns(history.value);
      setLoading(false);
      if (failed || (history.status === 'fulfilled' && history.value.some(isActive))) {
        timer = window.setTimeout(() => void refresh(), 2500);
      }
    }
    void refresh();
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [client, filter, revision]);

  const selectedSummary = runs.find((run) => run.id === selectedId);
  const selectedStatus = selectedSummary?.status;
  useEffect(() => {
    if (!selectedId || !client.getEvaluationRun) return;
    const controller = new AbortController();
    const signal = controller.signal;
    let timer: number | undefined;
    setDetailError(false);
    async function refresh() {
      try {
        const run = await client.getEvaluationRun!(selectedId!, signal);
        if (signal.aborted) return;
        setDetail(run);
        setDetailError(false);
        if (isActive(run)) timer = window.setTimeout(() => void refresh(), 2500);
      } catch {
        if (!signal.aborted) setDetailError(true);
      }
    }
    void refresh();
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [client, selectedId, selectedStatus, revision]);

  const start = async (benchmark: EvaluationBenchmark) => {
    if (!client.startEvaluation || action) return;
    setAction({ type: 'start', id: benchmark.id });
    try {
      const taskId = taskSelections[benchmark.id];
      const run = await client.startEvaluation({
        benchmarkId: benchmark.id,
        model: modelChoices.includes(model) ? model : undefined,
        taskIds: taskId ? [taskId] : undefined,
        concurrency: 2,
        maxAttempts: 1,
      });
      if (currentClient.current !== client) return;
      setFilter(benchmark.id);
      setSelectedId(run.id);
      setDetail(run);
      setRevision((value) => value + 1);
      onToast(`已启动 ${benchmark.title}`, 'success');
    } catch (error) {
      if (currentClient.current === client) onToast(error instanceof Error ? error.message : '启动评测失败', 'danger');
    } finally {
      if (currentClient.current === client) setAction(null);
    }
  };

  const cancel = async (run: EvaluationRun) => {
    if (!client.cancelEvaluation || action || !isActive(run) || run.cancelRequestedAt) return;
    setAction({ type: 'cancel', id: run.id });
    try {
      const updated = await client.cancelEvaluation(run.id);
      if (currentClient.current !== client) return;
      if (!updated) throw new Error('未找到此评测运行。');
      setDetail((current) => current?.id === updated.id ? updated : current);
      setRuns((current) => current.map((item) => item.id === updated.id ? updated : item));
      setRevision((value) => value + 1);
      if (updated.status === 'cancelled' || updated.cancelRequestedAt) {
        onToast(updated.status === 'cancelled' ? '评测已取消' : '已请求取消评测', 'success');
      }
    } catch (error) {
      if (currentClient.current === client) onToast(error instanceof Error ? error.message : '取消评测失败', 'danger');
    } finally {
      if (currentClient.current === client) setAction(null);
    }
  };

  const selected = detail?.id === selectedId ? detail : selectedSummary;
  const benchmarkTitle = (id: string) => benchmarks.find((benchmark) => benchmark.id === id)?.title || id;
  const refetch = () => setRevision((value) => value + 1);

  return (
    <section className="codex-page-view evaluation-page" aria-labelledby="evaluation-title">
      <header className="evaluation-heading">
        <div>
          <h1 id="evaluation-title">能力评测</h1>
          <p>选择基准测试，查看运行进度与逐项验收结果。</p>
        </div>
        {supported && <button type="button" className="codex-toolbar-btn" data-variant="outline" onClick={refetch} disabled={loading}>刷新</button>}
      </header>
      {!supported ? <p className="evaluation-state">当前连接未提供评测服务。</p> : <>
        {loadError && <p className="evaluation-state" role="alert">部分评测数据加载失败，正在重试。</p>}
        <section aria-labelledby="benchmark-title">
          <div className="evaluation-section-heading">
            <h2 id="benchmark-title">基准测试</h2>
            {modelChoices.length > 0 && <select className="codex-select" aria-label="选择评测模型"
              value={modelChoices.includes(model) ? model : ''} onChange={(event) => setModel(event.target.value)}>
              <option value="">运行时默认模型</option>
              {modelChoices.map((name) => <option key={name} value={name}>{name}</option>)}
            </select>}
          </div>
          {benchmarks.length ? (
            <ul className="evaluation-benchmarks">
              {benchmarks.map((benchmark) => (
                <li key={benchmark.id}>
                  <div>
                    <strong>{benchmark.title}</strong>
                    <p>{benchmark.taskCount} 项任务 · 基准 {benchmark.version} · 数据集 {benchmark.datasetVersion}</p>
                  </div>
                  <div className="evaluation-benchmark-actions">
                    {benchmark.tasks?.length ? <select className="codex-select" aria-label={`${benchmark.title} 的评测任务`}
                      value={taskSelections[benchmark.id] ?? ''} onChange={(event) => {
                        const taskId = event.target.value;
                        setTaskSelections((current) => ({ ...current, [benchmark.id]: taskId }));
                      }}>
                      <option value="">全部任务</option>
                      {benchmark.tasks.map((task) => <option key={task.id} value={task.id}>{task.title}</option>)}
                    </select> : null}
                    <button type="button" className="codex-toolbar-btn" data-variant="outline"
                    aria-label={`运行 ${benchmark.title}`} disabled={Boolean(action) || !client.startEvaluation}
                    onClick={() => void start(benchmark)}>
                      {action?.id === benchmark.id && action.type === 'start' ? '正在启动…' : '运行'}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          ) : <p className="evaluation-state">{loading ? '正在加载基准测试…' : '暂无可用的基准测试。'}</p>}
        </section>
        <section className="evaluation-history" aria-labelledby="run-history-title">
          <div className="evaluation-section-heading">
            <h2 id="run-history-title">运行记录</h2>
            <select className="codex-select" aria-label="筛选基准测试" value={filter} onChange={(event) => {
              setFilter(event.target.value);
              setSelectedId(null);
              setDetail(null);
              setRuns([]);
            }}>
              <option value="">全部基准</option>
              {benchmarks.map((benchmark) => <option key={benchmark.id} value={benchmark.id}>{benchmark.title}</option>)}
            </select>
          </div>
          {runs.length ? (
            <ul className="evaluation-runs" aria-label="评测运行">
              {runs.map((run) => (
                <li key={run.id}>
                  <button type="button" className="evaluation-run-row" aria-expanded={selectedId === run.id} onClick={() => {
                    setDetail(null);
                    setSelectedId((id) => id === run.id ? null : run.id);
                  }}>
                    <span><strong>{benchmarkTitle(run.benchmarkId)}</strong><small>{new Date(run.createdAt).toLocaleString()} · {run.model || '默认模型'}</small></span>
                    <span className="evaluation-run-progress">
                      {run.score && <small>{run.score.passed}/{run.score.total} 通过</small>}
                      <Status run={run} />
                    </span>
                  </button>
                  {selected?.id === run.id && (
                    <div className="evaluation-detail">
                      <div className="evaluation-detail-meta">
                        <span>数据集 {selected.datasetVersion} · {selected.results?.length ?? 0} 项结果</span>
                        {isActive(selected) && !selected.cancelRequestedAt && client.cancelEvaluation && (
                          <button type="button" className="codex-toolbar-btn" data-variant="outline" disabled={Boolean(action)} onClick={() => void cancel(selected)}>
                            {action?.id === selected.id && action.type === 'cancel' ? '正在请求…' : '取消评测'}
                          </button>
                        )}
                      </div>
                      {selected.error && <p className="evaluation-state" role="alert">{selected.error}</p>}
                      {detailError && <p className="evaluation-state" role="alert">更新运行详情失败。</p>}
                      {selected.results?.length ? (
                        <ul className="evaluation-results">
                          {selected.results.map((result) => (
                            <li key={result.taskId}>
                              <div><strong>{result.taskId}</strong><small>{result.error || result.judge?.reason || '—'}</small></div>
                              <span>{statusLabels[result.status]} · {fmtDuration(result.durationMs)}</span>
                            </li>
                          ))}
                        </ul>
                      ) : <p className="evaluation-state">暂未产生任务结果。</p>}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          ) : <p className="evaluation-state">{loading ? '正在加载运行记录…' : '暂无运行记录。'}</p>}
        </section>
        <EvaluationComparison client={client} runs={runs} title={benchmarkTitle} />
        <ModelCapabilityPanel client={client} revision={revision + runs.filter((run) => run.status === 'completed').length} />
      </>}
    </section>
  );
}
