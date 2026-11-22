import { useEffect, useState } from 'react';
import type { AgentBackendClient } from '../api/client';
import type { ModelCapabilityProfile } from '../types/backend';

const dimensions: Record<string, string> = {
  coding: '编码', reasoning: '推理', research: '研究', planning: '规划', testing: '测试', reviewing: '审查',
  data_analysis: '数据分析', multimodal: '多模态', tool_usage: '工具使用', context_capacity: '上下文容量',
  execution_speed: '执行速度', reliability: '可靠性',
};
const pct = (value: number) => `${Math.round(value * 100)}%`;

export function ModelCapabilityPanel({ client, revision }: { client: AgentBackendClient; revision: number }) {
  const [profiles, setProfiles] = useState<ModelCapabilityProfile[]>();
  const [error, setError] = useState('');
  const list = client.listModelCapabilities;

  useEffect(() => {
    if (!list) return;
    const controller = new AbortController();
    const { signal } = controller;
    setError('');
    void list.call(client, signal).then((items) => {
      if (!signal.aborted) setProfiles(items);
    }, () => {
      if (!signal.aborted) setError('模型能力画像加载失败。');
    });
    return () => controller.abort();
  }, [client, list, revision]);

  if (!list) return null;
  return <section className="evaluation-history" aria-labelledby="capability-evidence-title">
    <h2 id="capability-evidence-title">模型能力画像</h2>
    {error && <p className="evaluation-state" role="alert">{error}</p>}
    {!error && !profiles && <p className="evaluation-state" role="status">正在读取能力画像…</p>}
    {!error && profiles?.length === 0 && <p className="evaluation-state">暂无模型声明或评测数据。</p>}
    <ul className="evaluation-results capability-profile-list">
      {profiles?.map((profile) => {
        const { declared, measured } = profile;
        const keys = [...new Set([...Object.keys(declared?.capabilities || {}), ...Object.keys(measured?.capabilities || {})])];
        return <li key={profile.id}>
          <details>
            <summary>{declared?.label || profile.id} <small>· {measured ? `${measured.sampleCount} 个实测样本` : '暂无实测'}</small></summary>
            {measured && <p className="evaluation-state">
              置信度 {pct(measured.confidence)}{measured.empiricalScore != null && ` · 样本通过率 ${pct(measured.empiricalScore)}`}<br />
              数据集 {measured.evaluation.datasetVersion ?? '—'} · 评测 <code>{measured.evaluation.evaluationRunId}</code>
            </p>}
            {keys.length > 0 && <table>
              <thead><tr><th scope="col">能力维度</th><th scope="col">声明权重</th><th scope="col">实测权重</th></tr></thead>
              <tbody>{keys.map((key) => <tr key={key}>
                <th scope="row">{dimensions[key] ?? key}</th>
                <td>{declared ? pct(declared.capabilities[key] ?? 0) : '—'}</td>
                <td>{measured ? pct(measured.capabilities[key] ?? 0) : '—'}</td>
              </tr>)}</tbody>
            </table>}
          </details>
        </li>;
      })}
    </ul>
  </section>;
}
