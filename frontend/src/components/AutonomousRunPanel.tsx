import { useEffect, useState } from 'react';
import type { AgentBackendClient } from '../api/client';
import type {
  SwarmArtifactFile, SwarmArtifactRecord, SwarmMessageRecord, SwarmReplanRecord, SwarmRunRecord,
} from '../types/backend';

const labels: Record<string, string> = {
  pending: '待处理', planning: '规划中', ready: '可执行', queued: '排队中', running: '执行中',
  parked: '已暂停', interrupted: '已中断', reconciling: '等待核对', aggregating: '汇总中',
  verifying: '验收中', completed: '已完成', failed: '失败', cancelled: '已取消',
  stored: '已保存', archived: '已归档', applied: '已应用', superseded: '已替换',
  delivered: '已投递', claimed: '处理中', acked: '已确认', expired: '已过期', dead_letter: '死信',
  added: '新增', modified: '修改', deleted: '删除', renamed: '重命名',
};
const messageLabels: Record<string, string> = {
  task_assignment: '分配任务', task_update: '更新任务', task_completed: '完成任务', task_failed: '任务失败',
  artifact_published: '发布产物', artifact_requested: '请求产物', dependency_ready: '依赖已就绪',
  clarification_required: '请求澄清', review_requested: '请求审查', review_result: '审查结果',
  cancellation_requested: '请求取消', budget_warning: '预算预警', handoff: '交接',
  'task.start': '分配任务', 'task.update': '更新任务', 'task.complete': '完成任务',
  'artifact.publish': '发布产物', 'review.request': '请求审查', note: '消息',
};
const status = (value: string) => labels[value] ?? value;
const isActive = (run: SwarmRunRecord) => !['completed', 'failed', 'cancelled'].includes(run.status);
const errorText = (error: unknown) => error instanceof Error ? error.message : '请求失败，请重试。';
const when = (ms: number) => new Date(ms).toLocaleString();
const limit = 30;

function Button({ children, ...props }: React.ComponentProps<'button'>) {
  return <button type="button" className="codex-toolbar-btn" data-variant="outline" {...props}>{children}</button>;
}

interface RunPanelProps {
  client: AgentBackendClient;
  sessionId: string | null;
  preferredRunId?: string;
}

export function AutonomousRunPanel({ client, sessionId, preferredRunId }: RunPanelProps) {
  const list = client.listSwarmRuns;
  const [runs, setRuns] = useState<SwarmRunRecord[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const refresh = () => setRevision((value) => value + 1);

  useEffect(() => {
    if (preferredRunId) setSelectedId(preferredRunId);
  }, [preferredRunId]);

  useEffect(() => {
    if (!list || !sessionId) return;
    setLoading(true);
    const controller = new AbortController();
    const { signal } = controller;
    let timer: number | undefined;
    async function load() {
      try {
        const next = await client.listSwarmRuns!({ sessionId: sessionId!, limit, signal });
        if (signal.aborted) return;
        setRuns(next);
        setError('');
        if (!next.some(isActive)) return;
      } catch (failure) {
        if (signal.aborted) return;
        setError(errorText(failure));
      } finally {
        if (!signal.aborted) setLoading(false);
      }
      if (!signal.aborted) timer = window.setTimeout(() => void load(), 3000);
    }
    void load();
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [client, list, sessionId, revision, preferredRunId]);

  if (!sessionId) return <div className="autonomous-panel"><p>打开会话后可查看自主任务。输入 <code>/goal 目标</code> 可启动新任务。</p></div>;
  if (!list) return <div className="autonomous-panel"><p>当前连接未提供自主任务服务。</p></div>;
  const selected = runs.find((run) => run.id === selectedId) ?? runs[0];
  return <section className="autonomous-panel" aria-label="自主任务执行">
    <div className="autonomous-toolbar">
      {runs.length > 0 && <select className="codex-select" aria-label="选择自主任务" value={selected?.id ?? ''} onChange={(event) => setSelectedId(event.target.value)}>
        {runs.map((run) => <option key={run.id} value={run.id}>{status(run.status)} · {run.goal.slice(0, 100)}</option>)}
      </select>}
      <Button onClick={refresh} disabled={loading}>刷新</Button>
    </div>
    {error && <p className="autonomous-error" role="alert">加载自主任务失败。{error}</p>}
    {loading && <p role="status">正在加载自主任务…</p>}
    {!loading && !error && !selected && <p>此会话暂无自主任务。输入 <code>/goal 目标</code> 开始。</p>}
    {selected && <RunDetail key={selected.id} run={selected} client={client} revision={revision} onRefresh={refresh} />}
  </section>;
}

type Section = 'plan' | 'messages' | 'artifacts';
const sections: Record<Section, string> = { plan: '计划和节点', messages: '协作消息', artifacts: '产物' };

function RunDetail({ run, client, revision, onRefresh }: {
  run: SwarmRunRecord; client: AgentBackendClient; revision: number; onRefresh: () => void;
}) {
  const [section, setSection] = useState<Section>('plan');
  const [feedback, setFeedback] = useState<{ text: string; failed?: boolean }>();
  const [pending, setPending] = useState(false);
  const [updated, setUpdated] = useState<SwarmRunRecord>();
  const current = updated && updated.updatedAt >= run.updatedAt ? updated : run;

  async function change(action: 'cancel' | 'resume') {
    if (pending) return;
    const mutate = action === 'cancel' ? client.cancelSwarmRun : client.resumeSwarmRun;
    if (!mutate || (action === 'cancel' && !window.confirm('取消此自主任务及其正在执行的子任务？'))) return;
    setPending(true);
    setFeedback(undefined);
    try {
      const result = await mutate.call(client, run.id);
      setUpdated(result);
      setFeedback({ text: `任务状态已更新为「${status(result.status)}」。` });
      onRefresh();
    } catch (error) {
      setFeedback({ text: errorText(error), failed: true });
    } finally {
      setPending(false);
    }
  }

  return <>
    <header className="autonomous-summary">
      <div><strong>{status(current.status)}</strong> <small>计划 v{current.planVersion ?? 1} · {current.nodes.filter((node) => node.status === 'completed').length}/{current.nodes.length} 节点完成</small></div>
      <p>{current.goal}</p>
      {current.verdict ? <details className="autonomous-verdict">
        <summary>{current.verdict.accepted ? '验收通过' : '验收未通过'}</summary>
        {current.verdict.reasons?.length ? <ul>{current.verdict.reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul> : <p>未记录验收说明。</p>}
      </details> : !isActive(current) && <p><small>无验收记录</small></p>}
      {current.errorCode && <p className="autonomous-error">{current.errorMessage || current.errorCode}</p>}
      <div className="autonomous-toolbar">
        {isActive(current) && client.cancelSwarmRun && <Button onClick={() => void change('cancel')} disabled={pending}>取消任务</Button>}
        {current.status === 'failed' && client.resumeSwarmRun && <Button onClick={() => void change('resume')} disabled={pending}>恢复执行</Button>}
      </div>
      {feedback && <p role={feedback.failed ? 'alert' : 'status'} className={feedback.failed ? 'autonomous-error' : undefined}>{feedback.text}</p>}
    </header>
    <nav className="autonomous-sections" aria-label="执行详情">
      {(Object.keys(sections) as Section[]).map((key) => <Button key={key} aria-pressed={section === key} onClick={() => setSection(key)}>{sections[key]}</Button>)}
    </nav>
    <RunSection key={section} client={client} run={current} section={section} revision={revision} onRefresh={onRefresh} />
  </>;
}

type SectionData = SwarmArtifactRecord[] | SwarmMessageRecord[] | SwarmReplanRecord[];

function RunSection({ client, run, section, revision, onRefresh }: {
  client: AgentBackendClient; run: SwarmRunRecord; section: Section; revision: number; onRefresh: () => void;
}) {
  const [data, setData] = useState<SectionData>();
  const [error, setError] = useState('');
  const { id, updatedAt } = run;
  const active = isActive(run);
  const supported = Boolean(section === 'plan' ? client.listSwarmReplans : section === 'messages' ? client.listSwarmMessages : client.listSwarmArtifacts);
  useEffect(() => {
    if (!supported) return;
    const controller = new AbortController();
    const { signal } = controller;
    let timer: number | undefined;
    async function load() {
      try {
        let items: SectionData;
        if (section === 'plan') items = await client.listSwarmReplans!(id, signal);
        else if (section === 'messages') items = await client.listSwarmMessages!(id, signal);
        else items = await client.listSwarmArtifacts!(id, { signal });
        if (signal.aborted) return;
        setData(items);
        setError('');
      } catch (failure) {
        if (!signal.aborted) setError(errorText(failure));
      }
      if (active && !signal.aborted) timer = window.setTimeout(() => void load(), 4000);
    }
    void load();
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [client, id, updatedAt, section, supported, active, revision]);

  return <div className="autonomous-section">
    {section === 'plan' && <>
      {run.nodes.length ? <ol className="autonomous-list" aria-label="计划节点">
        {run.nodes.map((node) => <li key={node.id}>
          <details>
            <summary>{node.nodeKey} <small>· {status(node.status)}</small></summary>
            <p>{node.objective}</p>
            <p><small>{[node.agentProfileId, node.model, node.provider].filter(Boolean).join(' · ')}</small></p>
            {node.dependencies.length > 0 && <p>依赖 {node.dependencies.join('、')}</p>}
            {node.acceptance && <p>验收条件：{node.acceptance}</p>}
            {node.errorCode && <p className="autonomous-error">{node.errorMessage || node.errorCode}</p>}
          </details>
        </li>)}
      </ol> : <p>{active ? '等待计划节点生成。' : '此运行无计划节点。'}</p>}
      <h3>重规划记录</h3>
      {(data as SwarmReplanRecord[] | undefined)?.map((item) => <details key={item.id}>
        <summary>v{item.version} · {item.strategy}</summary>
        <p>{item.reason || '未记录原因'}{item.failedNodeKey && ` · ${item.failedNodeKey}`}</p>
        <small>{when(item.createdAt)}</small>
      </details>)}
    </>}
    {section === 'messages' && (data as SwarmMessageRecord[] | undefined)?.length ? <ol className="autonomous-list" aria-label="协作消息">
      {(data as SwarmMessageRecord[]).slice().sort((first, second) => second.createdAt - first.createdAt).map((message) => <li key={message.messageId}>
        <strong>{messageLabels[message.kind] ?? message.kind}</strong> <small>{status(message.status)}</small>
        <p>{message.fromAgentId} → {message.toAgentId}</p>
        {message.artifactManifest?.artifacts.map((ref) => <code key={ref.uri}>{ref.uri}</code>)}
        <small>{when(message.createdAt)}{message.planVersion != null && ` · v${message.planVersion}`}</small>
      </li>)}
    </ol> : null}
    {section === 'artifacts' && (data as SwarmArtifactRecord[] | undefined)?.map((artifact) =>
      <ArtifactDetail key={artifact.id} artifact={artifact} client={client} onRefresh={onRefresh} />)}
    {!supported && <p>当前连接未提供{sections[section]}接口。</p>}
    {error && <p className="autonomous-error" role="alert">{sections[section]}加载失败。{error}</p>}
    {supported && !data && !error && <p role="status">正在加载…</p>}
    {data?.length === 0 && !error && <p>暂无{section === 'plan' ? '重规划记录' : sections[section]}。</p>}
  </div>;
}

function ArtifactDetail({ artifact, client, onRefresh }: {
  artifact: SwarmArtifactRecord; client: AgentBackendClient; onRefresh: () => void;
}) {
  const [path, setPath] = useState<string>();
  const [file, setFile] = useState<SwarmArtifactFile>();
  const [fileError, setFileError] = useState('');
  const [feedback, setFeedback] = useState<{ text: string; failed?: boolean }>();
  const [busy, setBusy] = useState(false);
  const { id, runId } = artifact;

  useEffect(() => {
    if (!path || !client.readSwarmArtifactFile) return;
    const controller = new AbortController();
    const { signal } = controller;
    void client.readSwarmArtifactFile(runId, id, path, signal).then((result) => {
      if (!signal.aborted) setFile(result);
    }, (error) => {
      if (!signal.aborted) setFileError(errorText(error));
    });
    return () => controller.abort();
  }, [client, id, runId, path]);

  async function handle(action: 'verify' | 'apply') {
    if (busy) return;
    if (action === 'apply' && !window.confirm(`将 ${artifact.nodeKey} 的 ${artifact.fileCount} 个变更应用到父工作区？`)) return;
    setBusy(true);
    setFeedback(undefined);
    try {
      if (action === 'verify' && client.verifySwarmArtifact) {
        const result = await client.verifySwarmArtifact(runId, id);
        setFeedback(result.ok
          ? { text: `完整性校验通过${result.checkedFiles == null ? '' : ` · ${result.checkedFiles} 个文件`}` }
          : { text: '完整性校验失败。产物可能缺失或已损坏。', failed: true });
      } else if (action === 'apply' && client.applySwarmArtifact) {
        const result = await client.applySwarmArtifact(runId, id, { approved: true });
        if (!result.ok || result.status !== 'applied') throw new Error('工作区未应用此产物，请检查冲突。');
        setFeedback({ text: '已应用到父工作区。' });
        onRefresh();
      }
    } catch (error) {
      setFeedback({ text: errorText(error), failed: true });
    } finally {
      setBusy(false);
    }
  }

  function download() {
    if (!file || file.base64 == null || !file.verified) return;
    const bytes = Uint8Array.from(atob(file.base64), (character) => character.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = file.entry.path.split('/').at(-1) || 'artifact';
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return <details className="autonomous-artifact">
    <summary>{artifact.nodeKey} <small>· {artifact.fileCount} 个文件 · {status(artifact.status)}</small></summary>
    <p><code>{artifact.uri}</code></p>
    <div className="autonomous-toolbar">
      {client.verifySwarmArtifact && <Button onClick={() => void handle('verify')} disabled={busy}>校验完整性</Button>}
      {client.applySwarmArtifact && !artifact.appliedAt && <Button onClick={() => void handle('apply')} disabled={busy}>应用到父工作区</Button>}
    </div>
    {feedback && <p role={feedback.failed ? 'alert' : 'status'} className={feedback.failed ? 'autonomous-error' : undefined}>{feedback.text}</p>}
    {artifact.files.length > 0 && <ul className="autonomous-list">
      {artifact.files.map((entry) => <li key={entry.path}>
        <Button disabled={!client.readSwarmArtifactFile} aria-pressed={path === entry.path} onClick={() => {
          setFile(undefined);
          setFileError('');
          setPath(path === entry.path ? undefined : entry.path);
        }}>{entry.path} <small>{status(entry.changeType ?? entry.status ?? '')}</small></Button>
      </li>)}
    </ul>}
    {path && (fileError ? <p className="autonomous-error" role="alert">{fileError}</p> : !file ? <p role="status">正在读取文件…</p> :
      <div className="autonomous-preview">
        {file.deleted ? <p>此文件已删除。</p> : <>
          <div className="autonomous-toolbar">
            {file.verified && <small>SHA-256 已校验</small>}
            <Button disabled={!file.verified || file.base64 == null} onClick={download}>下载文件</Button>
          </div>
          {file.text == null ? <p>二进制文件，可下载查看。</p> : <pre>{file.text.slice(0, 60000)}{file.text.length > 60000 && '\n…（预览已截断）'}</pre>}
        </>}
      </div>)}
  </details>;
}
