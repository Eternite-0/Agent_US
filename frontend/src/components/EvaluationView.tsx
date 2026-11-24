import { useEffect, useRef, useState } from 'react';
import type { AgentBackendClient } from '../api/client';
import type {
  AciAblationArmMetrics,
  AciAblationSummary,
  EvaluationBenchmark,
  EvaluationRun,
  EvaluationTaskResult,
  ModelSpec,
} from '../types/backend';
import { formatAciAblationLatexFallback } from '../utils/aciTelemetry.ts';
import { fmtDuration, fmtTokens } from '../utils/format';
import { CopyFeedbackIcon } from './CopyFeedbackIcon';
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
  const [ablation, setAblation] = useState<AciAblationSummary | null>(null);
  const [ablationLoading, setAblationLoading] = useState(false);
  const [copiedLatex, setCopiedLatex] = useState(false);
  const [action, setAction] = useState<{ type: 'start' | 'cancel'; id: string } | null>(null);
  const copyTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(copyTimer.current), []);
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
    setAblation(null);
    setAction(null);
  }, [client]);

  useEffect(() => {
    if (!client.getAciAblationSummary) return;
    const controller = new AbortController();
    const { signal } = controller;
    setAblationLoading(true);
    void client.getAciAblationSummary(signal).then(
      (summary) => {
        if (!signal.aborted) setAblation(summary);
      },
      () => {
        if (!signal.aborted) setAblation({ available: false });
      },
    ).finally(() => {
      if (!signal.aborted) setAblationLoading(false);
    });
    return () => controller.abort();
  }, [client, revision]);

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
  const ablationArms: AciAblationArmMetrics[] = ablation?.available && ablation.summaryByArm
    ? (ablation.armOrder ?? Object.keys(ablation.summaryByArm))
        .map((armKey) => ablation.summaryByArm?.[armKey])
        .filter((item): item is AciAblationArmMetrics => Boolean(item))
    : [];
  const latexTableText = ablation?.available
    ? ablation.latexTable?.trim() || formatAciAblationLatexFallback(ablation)
    : '';
  const handleCopyLatex = async () => {
    if (!latexTableText) return;
    try {
      await navigator.clipboard.writeText(latexTableText);
      setCopiedLatex(true);
      window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopiedLatex(false), 1200);
      onToast('已复制 LaTeX 论文表', 'success');
    } catch {
      onToast('复制 LaTeX 论文表失败', 'danger');
    }
  };

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
        {client.getAciAblationSummary && (
          <section className="evaluation-history evaluation-ablation" aria-labelledby="aci-ablation-title">
            <div className="evaluation-section-heading">
              <div>
                <h2 id="aci-ablation-title">ACI A/C/D 消融对照</h2>
                {ablation?.available && (
                  <p className="evaluation-ablation-meta">
                    {[ablation.suite, ablation.model, ablation.createdAt ? new Date(ablation.createdAt).toLocaleString() : undefined]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                )}
              </div>
              {ablation?.available && (
                <button
                  type="button"
                  className="codex-toolbar-btn"
                  data-variant="outline"
                  aria-label="复制 LaTeX 论文表"
                  disabled={!latexTableText}
                  onClick={() => void handleCopyLatex()}
                >
                  <CopyFeedbackIcon copied={copiedLatex} size={14} />
                  <span>复制 LaTeX 论文表</span>
                </button>
              )}
            </div>
            {ablation?.available && ablationArms.length > 0 ? (
              <div className="evaluation-ablation-table-wrap">
                <table className="evaluation-ablation-table" aria-label="Arm A/C/D 消融结果表">
                  <thead>
                    <tr>
                      <th>实验组 / 策略</th>
                      <th>通过率 (Wilson 95% CI)</th>
                      <th>同题双通配对省 Token 率</th>
                      <th>Tok / Pass</th>
                      <th>Cache Hit %</th>
                      <th>Sup Tok</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ablationArms.map((m) => {
                      const ratePct = m.passRateCI.rate * 100;
                      const lowerPct = Math.max(0, Math.min(100, m.passRateCI.lower * 100));
                      const upperPct = Math.max(lowerPct, Math.min(100, m.passRateCI.upper * 100));
                      const pairedVal = m.pairedPassTokenReduction;
                      const pairedLabel =
                        m.arm === 'A' && (pairedVal === 0 || pairedVal === null)
                          ? '基线'
                          : pairedVal === null
                            ? 'N/A'
                            : `${(pairedVal * 100).toFixed(1)}%${m.pairedPassCount !== undefined ? ` (n=${m.pairedPassCount})` : ''}`;
                      return (
                        <tr key={m.arm} data-arm={m.arm}>
                          <td>
                            <div className="evaluation-ablation-arm">
                              <strong>Arm {m.arm}</strong>
                              {m.aciProfile && <code>{m.aciProfile}</code>}
                            </div>
                          </td>
                          <td>
                            <div className="evaluation-ci-cell">
                              <span className="tabular-nums">
                                {m.passedTrials}/{m.totalTrials} · {ratePct.toFixed(1)}% [{lowerPct.toFixed(1)}%, {upperPct.toFixed(1)}%]
                              </span>
                              <div
                                className="evaluation-ci-track"
                                role="img"
                                aria-label={`Arm ${m.arm} 通过率 ${ratePct.toFixed(1)}%，Wilson 95% CI ${lowerPct.toFixed(1)}% 至 ${upperPct.toFixed(1)}%`}
                              >
                                <span
                                  className="evaluation-ci-band"
                                  style={{ left: `${lowerPct}%`, width: `${Math.max(2, upperPct - lowerPct)}%` }}
                                />
                                <span className="evaluation-ci-point" style={{ left: `${ratePct}%` }} />
                              </div>
                            </div>
                          </td>
                          <td
                            className="tabular-nums"
                            data-tone={
                              pairedVal !== null && pairedVal > 0
                                ? 'positive'
                                : pairedVal !== null && pairedVal < 0
                                  ? 'negative'
                                  : undefined
                            }
                          >
                            {pairedLabel}
                          </td>
                          <td className="tabular-nums">
                            {m.tokensPerCompletedPass !== null
                              ? fmtTokens(Math.round(m.tokensPerCompletedPass))
                              : 'N/A'}
                          </td>
                          <td className="tabular-nums">{(m.cacheHitRate * 100).toFixed(1)}%</td>
                          <td className="tabular-nums">{Math.round(m.supervisorCost?.totalTokens ?? 0).toLocaleString('en-US')}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="evaluation-state">
                {ablationLoading ? '正在加载 A/C/D 消融实验数据…' : '暂无已归档的 ACI A/C/D 消融实验证据。'}
              </p>
            )}
          </section>
        )}
        <ModelCapabilityPanel client={client} revision={revision + runs.filter((run) => run.status === 'completed').length} />
      </>}
    </section>
  );
}
