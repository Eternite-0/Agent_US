import { useEffect, useState } from 'react';
import type { AgentBackendClient } from '../api/client';
import type { EvaluationRegressionSummary, EvaluationRun } from '../types/backend';
import { fmtDuration } from '../utils/format';

const runLabel = (run: EvaluationRun) => `${run.model || '默认模型'} · ${new Date(run.createdAt).toLocaleString()}`;
const taskSet = (run: EvaluationRun) => run.results?.length ? JSON.stringify(run.results.map((item) => item.taskId).sort()) : null;
const percent = (value: number) => `${(value * 100).toFixed(1)}%`;
const signed = (value: number, digits = 0) => `${value > 0 ? '+' : ''}${value.toFixed(digits)}`;

export function EvaluationComparison({ client, runs, title }: {
  client: AgentBackendClient;
  runs: EvaluationRun[];
  title: (benchmarkId: string) => string;
}) {
  const [baselineId, setBaselineId] = useState('');
  const [candidateId, setCandidateId] = useState('');
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<EvaluationRegressionSummary>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const completed = runs.filter((run) => run.status === 'completed' && run.score);
  const baseline = completed.find((run) => run.id === baselineId);
  const candidates = baseline ? completed.filter((run) => run.id !== baseline.id && run.benchmarkId === baseline.benchmarkId &&
    run.benchmarkVersion === baseline.benchmarkVersion && run.datasetVersion === baseline.datasetVersion &&
    taskSet(run) !== null && taskSet(run) === taskSet(baseline)) : [];
  const candidate = candidates.find((run) => run.id === candidateId);

  useEffect(() => {
    if (!revision || !baseline || !candidate || !client.getEvaluationRegression) return;
    const controller = new AbortController();
    const { signal } = controller;
    setBusy(true);
    setResult(undefined);
    setError('');
    void client.getEvaluationRegression({ benchmarkId: baseline.benchmarkId, baselineRunId: baseline.id, candidateRunId: candidate.id, signal }).then(
      (data) => { if (!signal.aborted) setResult(data); },
      (failure) => { if (!signal.aborted) setError(failure instanceof Error ? failure.message : '比较失败，请重试。'); },
    ).finally(() => { if (!signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [client, baseline?.id, candidate?.id, revision]);

  if (!client.getEvaluationRegression) return null;
  const canCompare = completed.length >= 2;
  function reset() {
    setRevision(0);
    setBusy(false);
    setError('');
    setResult(undefined);
  }

  return <section className="evaluation-history" aria-labelledby="evaluation-comparison-title">
    <h2 id="evaluation-comparison-title">历史比较</h2>
    {!canCompare ? <p className="evaluation-state">完成两次使用同一基准及数据集版本的运行后可比较。</p> : <>
      <div className="evaluation-compare-controls">
        <label>基线运行<select className="codex-select" value={baseline?.id ?? ''} onChange={(event) => {
          setBaselineId(event.target.value);
          setCandidateId('');
          reset();
        }}>
          <option value="">选择基线</option>
          {completed.map((run) => <option key={run.id} value={run.id}>{title(run.benchmarkId)} · {runLabel(run)}</option>)}
        </select></label>
        <label>候选运行<select className="codex-select" disabled={!candidates.length} value={candidate?.id ?? ''} onChange={(event) => {
          setCandidateId(event.target.value);
          reset();
        }}>
          <option value="">选择候选</option>
          {candidates.map((run) => <option key={run.id} value={run.id}>{runLabel(run)}</option>)}
        </select></label>
        <button type="button" className="codex-toolbar-btn" data-variant="outline" disabled={busy || !candidate} onClick={() => setRevision((value) => value + 1)}>
          {busy ? '比较中…' : '比较'}
        </button>
      </div>
      {baseline && !candidates.length && <p className="evaluation-state">没有同版本且使用相同任务的候选运行。</p>}
      {error && <p className="evaluation-state" role="alert">{error}</p>}
      {result && baseline && candidate && !error && <div className="evaluation-comparison-result" role="status">
        <strong>{result.passed ? '通过回归检查' : '检测到回归'}</strong>
        <span>通过率 {percent(baseline.score!.passRate)} → {percent(candidate.score!.passRate)}（{signed(result.passRateDelta * 100, 1)} 个百分点）</span>
        <span>超时 {signed(result.timeoutDelta)} 项 · 平均耗时 {result.durationDelta > 0 ? '+' : result.durationDelta < 0 ? '−' : ''}{fmtDuration(Math.abs(result.durationDelta))}</span>
      </div>}
    </>}
  </section>;
}
