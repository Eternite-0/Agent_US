import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import type { AgentBackendClient } from '../api/client';
import type {
  SwarmArtifactFile, SwarmArtifactRecord, SwarmMessageRecord, SwarmReplanRecord, SwarmRunRecord,
} from '../types/backend';

import { WorkerStatusMark } from './WorkerStatusMark';
import { subtaskTitle } from '../utils/worker';
import { swarmWorkerStatus } from '../utils/subagentProgress';
import { AgentAvatar } from './AgentAvatar';
import { IconActivity, IconArchive, IconBranch, IconCheck, IconChevronRight, IconCircleClose, IconDagNodes, IconDownload, IconFileDoc, IconHistory, IconPlay, IconRefresh, IconShieldCheck, IconStopSquare } from './Icons';
import type { SwarmSection } from './slashCommands';

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

const sections = {
  plan: { label: '计划和节点', icon: IconDagNodes },
  messages: { label: '协作消息', icon: IconActivity },
  artifacts: { label: '产物', icon: IconArchive },
};
const runningStatuses = new Set(['running', 'planning', 'verifying', 'aggregating', 'reconciling']);
const doneStatuses = new Set(['completed', 'applied', 'acked', 'stored', 'delivered']);
const errorStatuses = new Set(['failed', 'dead_letter']);
const warnStatuses = new Set(['parked', 'interrupted', 'expired']);
const terminalNodeStatuses = new Set(['completed', 'failed', 'cancelled', 'superseded']);

function RunStatus({ value }: { value: string }) {
  const tone = runningStatuses.has(value) ? 'pulse' : doneStatuses.has(value) ? 'live'
    : errorStatuses.has(value) ? 'danger' : warnStatuses.has(value) ? 'warn' : undefined;
  return <span className="swarm-status"><span className="codex-status-dot" data-tone={tone} aria-hidden="true" />{status(value)}</span>;
}

function RowContents({ icon, title, detail, end, expandable }: {
  icon: ReactNode; title: string; detail?: string; end?: ReactNode; expandable?: boolean;
}) {
  return <>
    <span className="swarm-row-icon" aria-hidden="true">{icon}</span>
    <span className="swarm-row-text">
      <span title={title}>{title}</span>
      {detail && <small title={detail}>{detail}</small>}
    </span>
    {end}
    {expandable && <IconChevronRight className="swarm-row-chevron" size={12} aria-hidden="true" />}
  </>;
}

function PanelState({ children }: { children: ReactNode }) {
  return <div className="swarm-empty"><IconDagNodes size={20} aria-hidden="true" /><p>{children}</p></div>;
}

interface RunPanelProps {
  client: AgentBackendClient;
  sessionId: string | null;
  preferredRunId?: string;
  sectionRequest?: { section: SwarmSection };
}

export function AutonomousRunPanel({ client, sessionId, preferredRunId, sectionRequest }: RunPanelProps) {
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

  if (!sessionId) return <div className="autonomous-panel"><PanelState>打开会话后可查看自主任务。输入 <code>/goal 目标</code> 可启动新任务。</PanelState></div>;
  if (!list) return <div className="autonomous-panel"><PanelState>当前连接未提供自主任务服务。</PanelState></div>;
  const selected = runs.find((run) => run.id === selectedId) ?? runs[0];
  return <section className="autonomous-panel" aria-label="自主任务执行">
    <div className="autonomous-toolbar swarm-run-selector">
      <IconDagNodes size={16} aria-hidden="true" />
      {runs.length > 0 && <select className="codex-select" aria-label="选择自主任务" value={selected?.id ?? ''} onChange={(event) => setSelectedId(event.target.value)}>
        {runs.map((run) => <option key={run.id} value={run.id}>{status(run.status)} · {run.goal.slice(0, 100)}</option>)}
      </select>}
      <Button onClick={refresh} disabled={loading} aria-label="刷新自主任务" title="刷新自主任务"><IconRefresh size={15} /></Button>
    </div>
    {error && <p className="autonomous-error" role="alert">加载自主任务失败。{error}</p>}
    {loading && <p role="status">正在加载自主任务…</p>}
    {!loading && !error && !selected && <PanelState>此会话暂无自主任务。输入 <code>/goal 目标</code> 开始。</PanelState>}
    {selected && <RunDetail key={selected.id} run={selected} client={client} sectionRequest={sectionRequest} revision={revision} onRefresh={refresh} />}
  </section>;
}

function RunDetail({ run, client, revision, onRefresh, sectionRequest }: {
  run: SwarmRunRecord; client: AgentBackendClient; revision: number; onRefresh: () => void; sectionRequest?: { section: SwarmSection };
}) {
  const [tab, setTab] = useState<{ request?: { section: SwarmSection }; section: SwarmSection }>();
  const section = tab && tab.request === sectionRequest ? tab.section : sectionRequest?.section ?? 'plan';
  const [feedback, setFeedback] = useState<{ text: string; failed?: boolean }>();
  const [pending, setPending] = useState(false);
  const [updated, setUpdated] = useState<SwarmRunRecord>();
  const current = updated && updated.updatedAt >= run.updatedAt ? updated : run;
  const completed = current.nodes.filter((node) => node.status === 'completed').length;

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
      <div className="swarm-run-meta">
        <RunStatus value={current.status} />
        <span className="swarm-plan-version"><IconBranch size={13} aria-hidden="true" />计划 v{current.planVersion ?? 1}</span>
      </div>
      <h2>{current.goal}</h2>
      {current.nodes.length > 0 && <div className="swarm-progress">
        <progress aria-label="节点完成进度" value={completed} max={current.nodes.length} />
        <small>{completed}/{current.nodes.length} 节点完成</small>
      </div>}
      {current.verdict ? <details className="autonomous-verdict">
        <summary className="codex-subagent-list-row swarm-row">
          <RowContents icon={current.verdict.accepted ? <IconShieldCheck size={15} /> : <IconCircleClose size={15} />}
            title={current.verdict.accepted ? '验收通过' : '验收未通过'} detail={current.verdict.verificationMode} expandable />
        </summary>
        <div className="swarm-row-detail">
          {current.verdict.reasons?.length ? <ul>{current.verdict.reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul> : <p>未记录验收说明。</p>}
        </div>
      </details> : !isActive(current) && <p><small>无验收记录</small></p>}
      {current.errorCode && <p className="autonomous-error">{current.errorMessage || current.errorCode}</p>}
      <div className="autonomous-toolbar">
        {isActive(current) && client.cancelSwarmRun && <Button onClick={() => void change('cancel')} disabled={pending}><IconStopSquare size={11} />取消任务</Button>}
        {current.status === 'failed' && client.resumeSwarmRun && <Button onClick={() => void change('resume')} disabled={pending}><IconPlay size={13} />恢复执行</Button>}
      </div>
      {feedback && <p role={feedback.failed ? 'alert' : 'status'} className={feedback.failed ? 'autonomous-error' : undefined}>{feedback.text}</p>}
    </header>
    <nav className="autonomous-sections" aria-label="执行详情">
      {(Object.keys(sections) as SwarmSection[]).map((key) => {
        const { icon: Icon, label } = sections[key];
        return <button type="button" className="swarm-section-tab" key={key} aria-pressed={section === key}
          onClick={() => setTab({ request: sectionRequest, section: key })}><Icon size={14} aria-hidden="true" />{label}</button>;
      })}
    </nav>
    <RunSection key={section} client={client} run={current} section={section} revision={revision} onRefresh={onRefresh} />
  </>;
}

type SectionData = SwarmArtifactRecord[] | SwarmMessageRecord[] | SwarmReplanRecord[];

function RunSection({ client, run, section, revision, onRefresh }: {
  client: AgentBackendClient; run: SwarmRunRecord; section: SwarmSection; revision: number; onRefresh: () => void;
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
      {run.nodes.length ? <>
        <NodeList label="待执行与进行中" nodes={run.nodes.filter((node) => !terminalNodeStatuses.has(node.status))} />
        <NodeList label="已结束" nodes={run.nodes.filter((node) => terminalNodeStatuses.has(node.status))} />
      </> : <PanelState>{active ? '等待计划节点生成。' : '此运行无计划节点。'}</PanelState>}
      <h3 className="codex-subagent-section-head swarm-section-heading"><IconHistory size={14} aria-hidden="true" />重规划记录</h3>
      {(data as SwarmReplanRecord[] | undefined)?.map((item) => <details key={item.id}>
        <summary className="codex-subagent-list-row swarm-row">
          <RowContents icon={<IconBranch size={16} />} title={`v${item.version} · ${item.strategy}`} detail={when(item.createdAt)} expandable />
        </summary>
        <div className="swarm-row-detail"><p>{item.reason || '未记录原因'}{item.failedNodeKey && ` · ${item.failedNodeKey}`}</p></div>
      </details>)}
    </>}
    {section === 'messages' && (data as SwarmMessageRecord[] | undefined)?.length ? <ol className="autonomous-list" aria-label="协作消息">
      {(data as SwarmMessageRecord[]).slice().sort((first, second) => second.createdAt - first.createdAt).map((message) => <li key={message.messageId}>
        <details>
          <summary className="codex-subagent-list-row swarm-row">
            <RowContents icon={<IconActivity size={16} />} title={messageLabels[message.kind] ?? message.kind}
              detail={`${message.fromAgentId} → ${message.toAgentId}`} end={<RunStatus value={message.status} />} expandable />
          </summary>
          <div className="swarm-row-detail">
            {message.artifactManifest?.artifacts.map((ref) => <p key={ref.uri}><IconFileDoc size={13} /> <code>{ref.uri}</code></p>)}
            <small>{when(message.createdAt)}{message.planVersion != null && ` · v${message.planVersion}`}</small>
          </div>
        </details>
      </li>)}
    </ol> : null}
    {section === 'artifacts' && (data as SwarmArtifactRecord[] | undefined)?.map((artifact) =>
      <ArtifactDetail key={artifact.id} artifact={artifact} client={client} onRefresh={onRefresh} />)}
    {!supported && <p>当前连接未提供{sections[section].label}接口。</p>}
    {error && <p className="autonomous-error" role="alert">{sections[section].label}加载失败。{error}</p>}
    {supported && !data && !error && <p role="status">正在加载…</p>}
    {data?.length === 0 && !error && <p>暂无{section === 'plan' ? '重规划记录' : sections[section].label}。</p>}
  </div>;
}

function NodeList({ label, nodes }: { label: string; nodes: SwarmRunRecord['nodes'] }) {
  if (!nodes.length) return null;
  return <section className="swarm-node-group">
    <h3 className="codex-subagent-section-head swarm-section-heading">{label} · {nodes.length}</h3>
    <ul className="autonomous-list">
      {nodes.map((node) => <li key={node.id}>
        <details>
          <summary className="codex-subagent-list-row swarm-row">
            <RowContents icon={<AgentAvatar role={node.agentProfileId} size={18} />}
              title={subtaskTitle(node.objective, node.nodeKey)} detail={[node.agentProfileId, node.model].filter(Boolean).join(' · ')}
              end={<span className="swarm-status"><WorkerStatusMark status={node.status === 'superseded' ? 'cancelled' : swarmWorkerStatus(node.status)} />{status(node.status)}</span>} expandable />
          </summary>
          <div className="swarm-row-detail">
            <p>{node.objective}</p>
            <small>节点 <code>{node.nodeKey}</code></small>
            {node.provider && <p><small>提供商 · {node.provider}</small></p>}
            {node.dependencies.length > 0 && <div className="swarm-dependencies">
              <IconBranch size={13} aria-hidden="true" /><small>依赖</small>
              {node.dependencies.map((dependency) => <code key={dependency}>{dependency}</code>)}
            </div>}
            {node.acceptance && <p><IconShieldCheck size={13} aria-hidden="true" /> 验收条件 · {node.acceptance}</p>}
            {node.errorCode && <p className="autonomous-error">{node.errorMessage || node.errorCode}</p>}
          </div>
        </details>
      </li>)}
    </ul>
  </section>;
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
    <summary className="codex-subagent-list-row swarm-row">
      <RowContents icon={<IconArchive size={16} />} title={artifact.nodeKey} detail={`${artifact.fileCount} 个文件 · ${when(artifact.createdAt)}`}
        end={<RunStatus value={artifact.status} />} expandable />
    </summary>
    <div className="swarm-row-detail">
      <p><code>{artifact.uri}</code></p>
      <div className="autonomous-toolbar">
        {client.verifySwarmArtifact && <Button onClick={() => void handle('verify')} disabled={busy}><IconShieldCheck size={14} />校验完整性</Button>}
        {client.applySwarmArtifact && !artifact.appliedAt && <Button onClick={() => void handle('apply')} disabled={busy}><IconCheck size={14} />应用到父工作区</Button>}
      </div>
      {feedback && <p role={feedback.failed ? 'alert' : 'status'} className={feedback.failed ? 'autonomous-error' : undefined}>{feedback.text}</p>}
      {artifact.files.length > 0 && <ul className="autonomous-list">
        {artifact.files.map((entry) => <li key={entry.path}>
          <Button disabled={!client.readSwarmArtifactFile} aria-pressed={path === entry.path} onClick={() => {
            setFile(undefined);
            setFileError('');
            setPath(path === entry.path ? undefined : entry.path);
          }}><IconFileDoc size={14} /> <span>{entry.path}</span> <small>{status(entry.changeType ?? entry.status ?? '')}</small></Button>
        </li>)}
      </ul>}
      {path && (fileError ? <p className="autonomous-error" role="alert">{fileError}</p> : !file ? <p role="status">正在读取文件…</p> :
        <div className="autonomous-preview">
          {file.deleted ? <p>此文件已删除。</p> : <>
            <div className="autonomous-toolbar">
              {file.verified && <small>SHA-256 已校验</small>}
              <Button disabled={!file.verified || file.base64 == null} onClick={download}><IconDownload size={14} />下载文件</Button>
            </div>
            {file.text == null ? <p>二进制文件，可下载查看。</p> : <pre>{file.text.slice(0, 60000)}{file.text.length > 60000 && '\n…（预览已截断）'}</pre>}
          </>}
        </div>)}
    </div>
  </details>;
}
