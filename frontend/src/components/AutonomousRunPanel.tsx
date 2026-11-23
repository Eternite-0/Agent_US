import type { ReactNode } from 'react';
import { useCallback, useEffect, useState } from 'react';
import {
  type AgentBackendClient,
  collectSwarmReviewerVerdicts,
  extractSwarmTelemetry,
  formatSwarmApplyAllFeedback,
  getSwarmDeliveryApplyState,
  isUnsupportedSwarmEndpointError,
} from '../api/client';
import type {
  Approval,
  SwarmArtifactFile,
  SwarmArtifactRecord,
  SwarmDeliveryRecord,
  SwarmMessageRecord,
  SwarmReplanRecord,
  SwarmReviewerVerdict,
  SwarmRunRecord,
  SwarmBudgetSnapshot,
  SwarmCommandReceipt,
} from '../types/backend';

import { WorkerStatusMark } from './WorkerStatusMark';
import { fmtTokens } from '../utils/format';
import { subtaskTitle } from '../utils/worker';
import { swarmWorkerStatus } from '../utils/subagentProgress';
import { AgentAvatar } from './AgentAvatar';
import {
  IconActivity, IconArchive, IconBranch, IconCheck, IconChevronRight, IconCircleClose, IconDagNodes,
  IconDiffBox, IconDownload, IconFileDoc, IconHistory, IconPlay, IconRefresh, IconShieldAlert,
  IconShieldCheck, IconStopSquare, IconTerminal,
} from './Icons';
import type { SwarmSection } from './slashCommands';

type PanelSection = SwarmSection | 'delivery';

const labels: Record<string, string> = {
  pending: '待处理', planning: '规划中', ready: '可执行', queued: '排队中', running: '执行中',
  parked: '已暂停', interrupted: '已中断', reconciling: '等待核对', aggregating: '汇总中',
  verifying: '验收中', completed: '已完成', failed: '失败', cancelled: '已取消',
  stored: '已保存', archived: '已归档', applied: '已应用', superseded: '已替换',
  delivered: '已投递', claimed: '处理中', acked: '已确认', expired: '已过期', dead_letter: '死信',
  added: '新增', modified: '修改', deleted: '删除', renamed: '重命名',
  pass: '通过', passed: '通过', fail: '未通过', needs_revision: '需修订', approved: '已批准',
  rejected: '已拒绝', conflict: '冲突', skipped: '已跳过', error: '错误',
  critical: '严重', high: '高', medium: '中', low: '低', warning: '警告', info: '提示',
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

function budgetValue(value: number | null | undefined): string {
  if (value === null) return '未设上限';
  return typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('zh-CN') : '未提供';
}

function Button({ children, ...props }: React.ComponentProps<'button'>) {
  return <button type="button" className="codex-toolbar-btn" data-variant="outline" {...props}>{children}</button>;
}

const sections: Record<PanelSection, { label: string; icon: typeof IconDagNodes }> = {
  plan: { label: '计划和节点', icon: IconDagNodes },
  messages: { label: '协作消息', icon: IconActivity },
  artifacts: { label: '产物', icon: IconArchive },
  delivery: { label: '交付审查', icon: IconDiffBox },
};
const runningStatuses = new Set(['running', 'planning', 'verifying', 'aggregating', 'reconciling']);
const doneStatuses = new Set(['completed', 'applied', 'acked', 'stored', 'delivered', 'pass', 'passed', 'approved']);
const errorStatuses = new Set(['failed', 'dead_letter', 'fail', 'error', 'rejected']);
const warnStatuses = new Set(['parked', 'interrupted', 'expired', 'needs_revision', 'warning', 'conflict', 'partial']);
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
  receipt?: SwarmCommandReceipt;
  eventSeq?: number;
  approvals?: Approval[];
  sectionRequest?: { section: SwarmSection };
}

export function AutonomousRunPanel({ client, sessionId, preferredRunId, receipt, eventSeq, approvals = [], sectionRequest }: RunPanelProps) {
  const list = client.listSwarmRuns;
  const [runs, setRuns] = useState<SwarmRunRecord[]>([]);
  const [selectedId, setSelectedId] = useState(preferredRunId ?? '');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const refresh = () => setRevision((value) => value + 1);

  useEffect(() => {
    if (!eventSeq) return;
    // Coalesce bursts of node and message events into one durable refresh.
    const timer = window.setTimeout(() => setRevision((value) => value + 1), 150);
    return () => window.clearTimeout(timer);
  }, [eventSeq]);

  useEffect(() => {
    setSelectedId(preferredRunId ?? '');
  }, [preferredRunId, receipt]);

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
        const awaitingList = receipt?.run && isActive(receipt.run) && !next.some((run) => run.id === receipt.runId);
        if (!next.some(isActive) && !awaitingList) return;
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
  }, [client, list, sessionId, revision, preferredRunId, receipt]);

  if (!sessionId) return <div className="autonomous-panel"><PanelState>打开会话后可查看自主任务。输入 <code>/swarm 目标</code> 可启动新任务。</PanelState></div>;
  if (!list && !receipt) return <div className="autonomous-panel"><PanelState>当前连接未提供自主任务服务。</PanelState></div>;
  const snapshot = receipt?.run;
  const listed = snapshot && runs.find((run) => run.id === snapshot.id);
  const options = snapshot && (!listed || listed.updatedAt < snapshot.updatedAt)
    ? [snapshot, ...runs.filter((run) => run.id !== snapshot.id)] : runs;
  const selected = options.find((run) => run.id === selectedId) ?? (receipt ? undefined : options[0]);
  return <section className="autonomous-panel" aria-label="自主任务执行">
    {receipt && <p role="status">命令回执 · {receipt.message}</p>}
    <div className="autonomous-toolbar swarm-run-selector">
      <IconDagNodes size={16} aria-hidden="true" />
      {options.length > 0 && <select className="codex-select" aria-label="选择自主任务" value={selected?.id ?? ''} onChange={(event) => setSelectedId(event.target.value)}>
        {!selected && <option value="" disabled>选择历史任务</option>}
        {options.map((run) => <option key={run.id} value={run.id}>{status(run.status)} · {run.goal.slice(0, 100)}</option>)}
      </select>}
      {list && <Button onClick={refresh} disabled={loading} aria-label="刷新自主任务" title="刷新自主任务"><IconRefresh size={15} /></Button>}

    </div>
    {error && <p className="autonomous-error" role="alert">加载自主任务失败。{error}</p>}
    {list && loading && <p role="status">正在加载自主任务…</p>}
    {!receipt && !loading && !error && !selected && <PanelState>此会话暂无自主任务。输入 <code>/swarm 目标</code> 开始。</PanelState>}
    {selected && <RunDetail key={selected.id} run={selected} client={client} approvals={approvals} sectionRequest={sectionRequest} revision={revision} onRefresh={refresh}
      receiptLedger={receipt?.runId === selected.id ? receipt.ledger : undefined} />}
  </section>;
}

interface DeliveryState {
  data?: SwarmDeliveryRecord;
  loading: boolean;
  error: string;
  unsupported: boolean;
}

function RunDetail({ run, client, approvals, revision, onRefresh, sectionRequest, receiptLedger }: {
  run: SwarmRunRecord; client: AgentBackendClient; approvals: Approval[]; revision: number; onRefresh: () => void; sectionRequest?: { section: SwarmSection };
  receiptLedger?: SwarmBudgetSnapshot | null;
}) {
  const [tab, setTab] = useState<{ request?: { section: SwarmSection }; section: PanelSection }>();
  const section: PanelSection = tab && tab.request === sectionRequest ? tab.section : sectionRequest?.section ?? 'plan';
  const [feedback, setFeedback] = useState<{ text: string; failed?: boolean }>();
  const [pending, setPending] = useState(false);
  const [updated, setUpdated] = useState<SwarmRunRecord>();
  const [deliveryRevision, setDeliveryRevision] = useState(0);
  const [unsupportedTarget, setUnsupportedTarget] = useState<{ client: AgentBackendClient; key: string }>();
  const [deliveryState, setDeliveryState] = useState<DeliveryState>({
    loading: Boolean(client.getSwarmDelivery),
    error: '',
    unsupported: !client.getSwarmDelivery,
  });
  const current = updated && updated.updatedAt >= run.updatedAt ? updated : run;
  const active = isActive(current);
  const completed = current.nodes.filter((node) => node.status === 'completed').length;
  const nodesBySession = new Map(current.nodes.flatMap((node) => node.childSessionId ? [[node.childSessionId, node] as const] : []));
  const pendingApprovals = approvals.filter((approval) =>
    approval.status === 'pending' && approval.taskId && nodesBySession.has(approval.taskId),
  );
  const runRevisionKey = `${current.id}:${revision}`;
  const reloadDelivery = useCallback(() => setDeliveryRevision((value) => value + 1), []);

  useEffect(() => {
    const fetchDelivery = client.getSwarmDelivery;
    if (!fetchDelivery) {
      setDeliveryState({ loading: false, error: '', unsupported: true });
      return;
    }
    if (unsupportedTarget?.client === client && unsupportedTarget.key === runRevisionKey) {
      setDeliveryState((prev) => ({ ...prev, loading: false, error: '', unsupported: true }));
      return;
    }
    const controller = new AbortController();
    const { signal } = controller;
    let timer: number | undefined;
    setDeliveryState((prev) => ({ ...prev, loading: !prev.data, error: '', unsupported: false }));
    async function load() {
      try {
        const next = await fetchDelivery!.call(client, current.id, signal);
        if (signal.aborted) return;
        setDeliveryState({ data: next, loading: false, error: '', unsupported: false });
        if (section === 'delivery' && active) {
          timer = window.setTimeout(() => void load(), 4000);
        }
      } catch (failure) {
        if (signal.aborted) return;
        if (isUnsupportedSwarmEndpointError(failure)) {
          setUnsupportedTarget({ client, key: runRevisionKey });
          setDeliveryState({ loading: false, error: '', unsupported: true });
          return;
        }
        setDeliveryState((prev) => ({ ...prev, loading: false, error: errorText(failure), unsupported: false }));
        if (section === 'delivery' && active) {
          timer = window.setTimeout(() => void load(), 4000);
        }
      }
    }
    void load();
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [client, current.id, current.updatedAt, section, active, revision, deliveryRevision, unsupportedTarget, runRevisionKey]);

  const telemetry = extractSwarmTelemetry(current, deliveryState.data);
  const delivery = deliveryState.data?.runId === current.id ? deliveryState.data : undefined;
  const planReason = current.plan?.metadata?.teamRationale;
  const deliveryReason = delivery?.planVersion === undefined || current.planVersion === undefined || delivery.planVersion >= current.planVersion
    ? delivery?.teamRationale : undefined;
  const teamRationale = deliveryReason || (typeof planReason === 'string' && planReason.trim());
  const ledger = [delivery?.budgetLedger, receiptLedger]
    .filter((snapshot): snapshot is SwarmBudgetSnapshot => Boolean(snapshot && (!snapshot.treeId || snapshot.treeId === current.id)))
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0];
  const effectiveVerdict = current.verdict ?? deliveryState.data?.verdict ?? null;
  const reviewerVerdicts = collectSwarmReviewerVerdicts(current, deliveryState.data);

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
        {current.planVersion != null && <span className="swarm-plan-version"><IconBranch size={13} aria-hidden="true" />计划 v{current.planVersion}</span>}
      </div>
      <h2>{current.goal}</h2>
      {teamRationale && <p><strong>单成员原因</strong> · {teamRationale}</p>}
      {ledger ? <div className="swarm-dependencies" aria-label="预算快照">
        <small>步骤预留 <code>{budgetValue(ledger.reservedSteps)}</code> · 剩余 <code>{budgetValue(ledger.remainingSteps)}</code></small>
        <small>Token 预留 <code>{budgetValue(ledger.reservedTokens)}</code> · 剩余 <code>{budgetValue(ledger.remainingTokens)}</code></small>
        {ledger.updatedAt != null && <small>预算更新于 {when(ledger.updatedAt)}</small>}
      </div> : <p><small>暂无预算快照</small></p>}
      {current.nodes.length > 0 && <div className="swarm-progress">
        <progress aria-label="节点完成进度" value={completed} max={current.nodes.length} />
        <small>{completed}/{current.nodes.length} 节点完成</small>
      </div>}
      {telemetry.hasTelemetry && <div className="swarm-dependencies" aria-label="执行遥测">
        {telemetry.steps !== undefined && <small>步骤 <code>{telemetry.steps}</code></small>}
        {telemetry.totalTokens !== undefined && <small title={
          telemetry.inputTokens !== undefined || telemetry.outputTokens !== undefined
            ? `输入 ${telemetry.inputTokens ?? 0} · 输出 ${telemetry.outputTokens ?? 0}`
            : undefined
        }>Token <code>{fmtTokens(telemetry.totalTokens)}</code></small>}
        {telemetry.replanCount !== undefined && <small>重规划 <code>{telemetry.replanCount}</code></small>}
        {telemetry.branch && <small title={telemetry.headSha ?? undefined}>
          <IconBranch size={12} aria-hidden="true" /> 分支 <code>{telemetry.branch}{telemetry.headSha ? ` @ ${telemetry.headSha.slice(0, 7)}` : ''}</code>
        </small>}
        {telemetry.testCommands.length > 0 && <small>测试 {telemetry.testCommands.map((cmd) => <code key={cmd}>{cmd}</code>)}</small>}
      </div>}
      {(effectiveVerdict || reviewerVerdicts.length > 0) ? <details className="autonomous-verdict">
        <summary className="codex-subagent-list-row swarm-row">
          <RowContents
            icon={effectiveVerdict ? (effectiveVerdict.accepted ? <IconShieldCheck size={15} /> : <IconCircleClose size={15} />) : <IconShieldCheck size={15} />}
            title={effectiveVerdict ? (effectiveVerdict.accepted ? '验收通过' : '验收未通过') : '独立审查记录'}
            detail={effectiveVerdict?.verificationMode || (reviewerVerdicts.length ? `${reviewerVerdicts.length} 项独立审查` : undefined)}
            expandable
          />
        </summary>
        <div className="swarm-row-detail">
          {effectiveVerdict?.reasons?.length ? <ul>{effectiveVerdict.reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul>
            : !reviewerVerdicts.length && <p>未记录验收说明。</p>}
          <ReviewerVerdictList verdicts={reviewerVerdicts} />
        </div>
      </details> : !active && <p><small>无验收记录</small></p>}
      {pendingApprovals.length > 0 && <div aria-label="Swarm 待审批">
        <a href="#/settings/approvals">处理 {pendingApprovals.length} 条待审批操作</a>
        <ul>
          {pendingApprovals.map((approval) => <li key={approval.id}>
            {nodesBySession.get(approval.taskId!)?.nodeKey} · {approval.kind === 'reconciliation' ? '结果核对' : approval.tool}
          </li>)}
        </ul>
      </div>}
      {current.errorCode && <p className="autonomous-error">{current.errorMessage || current.errorCode}</p>}
      <div className="autonomous-toolbar">
        {active && client.cancelSwarmRun && <Button onClick={() => void change('cancel')} disabled={pending}><IconStopSquare size={11} />取消任务</Button>}
        {current.status === 'failed' && client.resumeSwarmRun && <Button onClick={() => void change('resume')} disabled={pending}><IconPlay size={13} />恢复执行</Button>}
      </div>
      {feedback && <p role={feedback.failed ? 'alert' : 'status'} className={feedback.failed ? 'autonomous-error' : undefined}>{feedback.text}</p>}
    </header>
    <nav className="autonomous-sections" aria-label="执行详情">
      {(Object.keys(sections) as PanelSection[]).map((key) => {
        const { icon: Icon, label } = sections[key];
        return <button type="button" className="swarm-section-tab" key={key} aria-pressed={section === key}
          onClick={() => setTab({ request: sectionRequest, section: key })}><Icon size={14} aria-hidden="true" />{label}</button>;
      })}
    </nav>
    {section === 'delivery'
      ? <DeliveryReviewSection client={client} run={current} state={deliveryState} onRefresh={onRefresh} onReloadDelivery={reloadDelivery} />
      : <RunSection key={section} client={client} run={current} section={section} revision={revision} onRefresh={onRefresh} />}
  </>;
}

function ReviewerVerdictList({ verdicts }: { verdicts: SwarmReviewerVerdict[] }) {
  if (!verdicts.length) return null;
  return <div aria-label="独立审查结果">
    <p><small>独立审查 · {verdicts.length}</small></p>
    <ul className="autonomous-list">
      {verdicts.map((rv, index) => <li key={`${rv.nodeKey}-${index}`}>
        <div className="swarm-run-meta">
          <span><strong>{rv.nodeKey}</strong>{rv.reviewerModel ? <small> · {rv.reviewerModel}</small> : null}</span>
          <RunStatus value={rv.status} />
        </div>
        {rv.summary && <p>{rv.summary}</p>}
        {(rv.checkedArtifacts?.length || rv.evidenceRefs?.length) ? <div className="swarm-dependencies">
          {rv.checkedArtifacts?.length ? <small>核验产物 <code>{rv.checkedArtifacts.length}</code></small> : null}
          {rv.evidenceRefs?.length ? <small>证据引用 <code>{rv.evidenceRefs.length}</code></small> : null}
        </div> : null}
        {rv.findings && rv.findings.length > 0 && <ul aria-label={`${rv.nodeKey} 审查发现`}>
          {rv.findings.map((finding, fIdx) => <li key={fIdx}>
            <code>{status(finding.severity)}</code> {finding.message}
            {finding.evidenceRef && <> <code>{finding.evidenceRef}</code></>}
          </li>)}
        </ul>}
      </li>)}
    </ul>
  </div>;
}

function DeliveryReviewSection({ client, run, state, onRefresh, onReloadDelivery }: {
  client: AgentBackendClient;
  run: SwarmRunRecord;
  state: DeliveryState;
  onRefresh: () => void;
  onReloadDelivery: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ text: string; failed?: boolean }>();

  if (!client.getSwarmDelivery) {
    return <div className="autonomous-section"><p>当前连接未提供交付审查接口。</p></div>;
  }
  if (state.unsupported) {
    return <div className="autonomous-section"><PanelState>当前后端暂不支持交付审查，请查看「产物」标签页。</PanelState></div>;
  }
  if (state.error && !state.data) {
    return <div className="autonomous-section"><p className="autonomous-error" role="alert">交付审查加载失败。{state.error}</p></div>;
  }
  if (!state.data) {
    return <div className="autonomous-section"><p role="status">正在加载…</p></div>;
  }

  const delivery = state.data;
  const applyState = getSwarmDeliveryApplyState(delivery);
  const changedFiles = delivery.changedFiles ?? [];
  const testResults = delivery.testResults ?? [];
  const reviewerVerdicts = collectSwarmReviewerVerdicts(run, delivery);
  const diffPreview = delivery.unifiedDiffPreview ?? '';

  async function handleApplyAll() {
    if (busy || !client.applyAllSwarmArtifacts || !applyState.canApplyAll) return;
    if (!window.confirm(`确认将 ${applyState.unappliedCount} 个已验产物（涉及 ${changedFiles.length} 个文件）应用到父工作区？`)) {
      return;
    }
    setBusy(true);
    setFeedback(undefined);
    try {
      const result = await client.applyAllSwarmArtifacts(run.id, { approved: true });
      const nextFeedback = formatSwarmApplyAllFeedback(result, applyState.unappliedCount);
      setFeedback(nextFeedback);
      onReloadDelivery();
      if (!nextFeedback.failed) onRefresh();
    } catch (error) {
      setFeedback({ text: errorText(error), failed: true });
      onReloadDelivery();
    } finally {
      setBusy(false);
    }
  }

  return <div className="autonomous-section">
    {state.error && <p className="autonomous-error" role="alert">交付审查刷新失败。{state.error}</p>}
    <div className="autonomous-toolbar">
      {applyState.canApplyAll && client.applyAllSwarmArtifacts && <>
        <Button onClick={() => void handleApplyAll()} disabled={busy}>
          <IconCheck size={14} aria-hidden="true" />应用全部已验产物
        </Button>
        <small>待应用 {applyState.unappliedCount} 个产物</small>
      </>}
      {applyState.allApplied && <small role="status">所有已验产物均已应用到父工作区。</small>}
    </div>
    {feedback && <p role={feedback.failed ? 'alert' : 'status'} className={feedback.failed ? 'autonomous-error' : undefined}>{feedback.text}</p>}

    {applyState.hasConflicts && <section aria-label="文件冲突警告">
      <h3 className="codex-subagent-section-head swarm-section-heading autonomous-error">
        <IconShieldAlert size={14} aria-hidden="true" />文件冲突警告 · {applyState.conflicts.length}
      </h3>
      <ul className="autonomous-list" role="alert">
        {applyState.conflicts.map((conflict, index) => <li key={`${conflict.path}-${index}`} className="swarm-row-detail">
          <p className="autonomous-error"><code>{conflict.path}</code> · {conflict.reason}</p>
          {conflict.nodeKeys.length > 0 && <div className="swarm-dependencies">
            <small>涉及节点</small>
            {conflict.nodeKeys.map((key) => <code key={key}>{key}</code>)}
          </div>}
        </li>)}
      </ul>
    </section>}

    <h3 className="codex-subagent-section-head swarm-section-heading">
      <IconFileDoc size={14} aria-hidden="true" />变更文件 · {changedFiles.length}
    </h3>
    {changedFiles.length > 0 ? <ul className="autonomous-list" aria-label="变更文件">
      {changedFiles.map((file, index) => <li key={`${file.artifactId}-${file.path}-${index}`} className="swarm-row-detail">
        <div className="swarm-run-meta">
          <span>
            <code>{status(file.changeType || 'modified')}</code>{' '}
            <code>{file.previousPath ? `${file.previousPath} → ${file.path}` : file.path}</code>
          </span>
          <small>{file.nodeKey}{file.sha256 ? ` · ${file.sha256.slice(0, 8)}` : ''}</small>
        </div>
      </li>)}
    </ul> : <p><small>暂无变更文件。</small></p>}

    <h3 className="codex-subagent-section-head swarm-section-heading">
      <IconShieldCheck size={14} aria-hidden="true" />测试与验证结果 · {testResults.length}
    </h3>
    {testResults.length > 0 ? <ul className="autonomous-list" aria-label="测试与验证结果">
      {testResults.map((result, index) => <li key={`${result.nodeKey}-${index}`}>
        <details>
          <summary className="codex-subagent-list-row swarm-row">
            <RowContents
              icon={<IconTerminal size={15} />}
              title={result.command || result.nodeKey}
              detail={[result.nodeKey, result.exitCode != null ? `exit ${result.exitCode}` : ''].filter(Boolean).join(' · ')}
              end={<RunStatus value={result.status} />}
              expandable
            />
          </summary>
          <div className="swarm-row-detail">
            <p>{result.summary || '无输出摘要。'}</p>
          </div>
        </details>
      </li>)}
    </ul> : <p><small>暂无测试执行记录。</small></p>}

    {reviewerVerdicts.length > 0 && <>
      <h3 className="codex-subagent-section-head swarm-section-heading">
        <IconShieldCheck size={14} aria-hidden="true" />独立审查 · {reviewerVerdicts.length}
      </h3>
      <ReviewerVerdictList verdicts={reviewerVerdicts} />
    </>}

    <h3 className="codex-subagent-section-head swarm-section-heading">
      <IconDiffBox size={14} aria-hidden="true" />统一 Diff 预览
    </h3>
    {diffPreview ? <div className="autonomous-preview">
      <pre>{diffPreview.slice(0, 60000)}{diffPreview.length > 60000 && '\n…（预览已截断）'}</pre>
    </div> : <p><small>暂无统一 Diff 预览。</small></p>}
  </div>;
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
