/** Public DTOs. The frontend does not import the Cordis or DSH packages. */
export type Status =
  | 'planning'
  | 'running'
  | 'reviewing'
  | 'completed'
  | 'failed'
  | 'paused'
  | 'cancelled';
export type RecordId = string;
export interface Entity {
  id: RecordId;
  version: number;
  projectId: RecordId | null;
  taskId: RecordId | null;
}
export interface Project extends Entity {
  name: string;
}
export interface Budget {
  maxSteps?: number;
  maxDurationSeconds?: number;
  maxCostUSD?: number;
}
export type ApprovalMode = 'manual' | 'workspace-write' | 'auto-review';
export interface Submission {
  projectId: string;
  input: string;
  idempotencyKey: string;
  files?: Record<string, string>;
  budget?: Budget;
  approvalMode?: ApprovalMode;
}
export interface PlanNode {
  key: string;
  role: 'Researcher' | 'Planner' | 'Coder' | 'Reviewer' | 'Tester';
  objective: string;
  acceptance: string;
  dependencies: string[];
  requiredFiles?: string[];
}
export interface Task extends Entity {
  input: string;
  status: Status;
  approvalMode?: ApprovalMode;
  plan?: {
    type: string;
    complexity: 'simple' | 'medium' | 'complex';
    risk: 'low' | 'medium' | 'high';
    nodes: PlanNode[];
  };
  verdict?: { accepted: boolean; reason: string; failedNodes?: string[] };
}
export interface Approval extends Entity {
  workerId: string;
  assignmentId: string;
  kind?: 'reconciliation';
  parked?: boolean;
  checkpoint?: 'outward';
  status: 'pending' | 'approve' | 'deny' | 'revoked' | 'consumed' | 'expired';
  action: Record<string, unknown>;
  tool: string;
  digest: string;
  expires: number;
}
export interface IntegrityReport {
  ok: boolean;
  algorithm: string;
  lastSeq: number;
  legacyThroughSeq: number;
  verifiedThroughSeq: number;
  headDigest: string | null;
  checkedRows: number;
  hashedRows: number;
}
export interface MemoryEntry extends Entity {
  summary: string;
  refinementId?: string;
  title?: string;
  lesson?: string;
  status?: 'active' | 'expired' | 'withdrawn' | 'pinned';
  expiresAt?: number | null;
}
export interface EventEnvelope {
  seq: number;
  timestamp: number;
  type: string;
  projectId: string | null;
  taskId: string | null;
  payload: Record<string, unknown>;
}
export interface Artifact extends Entity {
  text: string;
  files: Record<string, string>;
  published: boolean;
  assignmentId: string;
}

// ---- P7 Unified Control-Plane & Autonomous Runtime DTOs (/v1/*) ----

export interface RuntimeSession {
  id: string;
  title: string;
  workspaceRoot: string;
  model: string;
  mode: string;
  permissionMode: string;
  state: string;
  parentSessionId?: string | null;
  rootSessionId?: string | null;
  agentProfile?: string;
  activeCompactionId?: string | null;
  plan?: { explanation?: string; steps: Array<{ id: string; title: string; status: string }> } | null;
  createdAt: number;
  updatedAt: number;
}

export interface RuntimeTurn {
  id: string;
  sessionId: string;
  input: string;
  model: string;
  state: string;
  phase?: string;
  step?: number;
  error?: string | null;
  verdict?: { verdict?: string; accepted?: boolean; reasons?: string[]; evidenceCount?: number } | null;
  evidenceCount?: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  createdAt: number;
  finishedAt?: number | null;
}

export interface ToolReceipt {
  id: string;
  sessionId: string;
  turnId: string;
  callId: string;
  toolName: string;
  riskLevel: string;
  effectClass: string;
  replayable: number;
  outward: number;
  status: string;
  exitCode?: number | null;
  durationMs: number;
  reconciliationOutcome?: string | null;
  createdAt: number;
}

export interface ReconciliationItem {
  id: string;
  sessionId: string;
  turnId?: string | null;
  callId?: string | null;
  tool: string;
  kind: string;
  receiptId?: string | null;
  status: string;
  outcome?: string | null;
  arguments: Record<string, unknown>;
  createdAt: number;
}

export interface SwarmNode {
  id: string;
  runId: string;
  nodeKey: string;
  agentProfileId: string;
  childSessionId?: string | null;
  model?: string | null;
  provider?: string | null;
  objective: string;
  dependencies: string[];
  status: string;
  priority: number;
  resultText?: string | null;
  artifactUris?: string[];
  latestArtifactId?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
}

export interface SwarmArtifactFileEntry {
  path: string;
  status: string;
  previousPath?: string | null;
  sizeBytes?: number;
  mode?: string | null;
  binary?: boolean;
  sha256?: string | null;
  baseSha256?: string | null;
}

export interface SwarmArtifact {
  id: string;
  uri: string;
  runId: string;
  nodeId: string;
  nodeKey: string;
  attempt: number;
  ownerId: string;
  baseCommit?: string | null;
  baseRef?: string | null;
  bundleSha256: string;
  fileCount: number;
  totalBytes: number;
  status: string;
  files: SwarmArtifactFileEntry[];
  appliedAt?: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface SwarmArtifactVerifyResult {
  ok: boolean;
  artifactId: string;
  bundleSha256?: string;
  reasons?: string[];
}

export interface SwarmArtifactApplyResult {
  applied: boolean;
  artifactId: string;
  appliedFiles?: string[];
  conflicts?: Array<{ path: string; reason: string }>;
}

export interface SwarmRun {
  id: string;
  sessionId: string;
  goal: string;
  status: string;
  planVersion?: number;
  currentPhase?: string;
  replanCount?: number;
  errorCode?: string | null;
  errorMessage?: string | null;
  usage: Record<string, unknown>;
  nodes: SwarmNode[];
  createdAt: number;
  updatedAt: number;
}

export interface SwarmSubmitResponse {
  runId: string;
  sessionId: string;
  status: string;
  run: SwarmRun;
}

export interface SwarmReplan {
  id: string;
  runId: string;
  version: number;
  failedNodeKey?: string | null;
  strategy: string;
  reason?: string | null;
  diff: Record<string, unknown>;
  createdAt: number;
}

export interface ChildNotification {
  id: string;
  idempotencyKey: string;
  parentSessionId: string;
  childSessionId: string;
  runId?: string | null;
  nodeKey?: string | null;
  status: string;
  payload: Record<string, unknown>;
  delivered: number;
  createdAt: number;
}

export interface ScheduledTaskRun {
  id: string;
  scheduleId: string;
  scheduledFor: number;
  idempotencyKey: string;
  jobId?: string | null;
  sessionId?: string | null;
  turnId?: string | null;
  status: string;
  runSeq?: number;
  trigger?: string;
  error?: string | null;
  startedAt?: number | null;
  finishedAt?: number | null;
  createdAt: number;
  updatedAt?: number | null;
}

export interface ScheduledTask {
  id: string;
  name: string;
  prompt: string;
  scheduleKind: string;
  scheduleExpr: string;
  timezone: string;
  concurrencyPolicy?: string;
  misfirePolicy?: string;
  maxConcurrency?: number;
  workspaceRoot?: string | null;
  model?: string | null;
  permissionMode: string;
  enabled: boolean;
  lastRunAt?: number | null;
  nextRunAt?: number | null;
  lastSessionId?: string | null;
  lastStatus?: string | null;
  lastStatusRunSeq?: number;
  lastStatusRunId?: string | null;
  runHistory: Array<{ runId?: string; sessionId: string; turnId: string; at: number; trigger: string }>;
  createdAt?: number;
  updatedAt?: number;
}

export interface RuntimeOverview {
  ok: boolean;
  activeTurns: number;
  pendingApprovals: number;
  pendingReconciliations: number;
  unknownReceipts: number;
  activeSwarmRuns: number;
  enabledSchedules: number;
  modelCount?: number;
}

export function connect(base: string, token: string) {
  async function request<T>(path: string, body?: unknown): Promise<T> {
    const res = await fetch(new URL(`/api/v1/${path}`, base), {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const data = await res.json();
      throw Error(
        `${data.error?.code ?? res.status} (${data.error?.requestId ?? 'unknown'})`,
      );
    }
    return res.json() as Promise<T>;
  }
  return {
    projects: () => request<Project[]>('projects'),
    project: (name: string) => request<Project>('projects', { name }),
    submit: (body: Submission) => request<Task>('tasks', body),
    task: (id: string) => request<Task>('tasks/' + encodeURIComponent(id)),
    approvals: (taskId: string) =>
      request<Approval[]>('approvals?' + new URLSearchParams({ taskId })),
    decide: (
      approval: Approval,
      decision: 'approve' | 'deny',
      extra?: { outcome?: 'succeeded' | 'not_applied' | 'abort'; reason?: string },
    ) =>
      request<Approval>(
        `approvals/${encodeURIComponent(approval.id)}/decision`,
        { version: approval.version, decision, ...extra },
      ),
    integrity: (full = false) =>
      request<IntegrityReport>(`integrity?full=${full ? 'true' : 'false'}`),
    renewMemory: (entry: MemoryEntry) =>
      request<MemoryEntry>(`memory/${encodeURIComponent(entry.id)}/renew`, {
        version: entry.version,
      }),
    withdrawMemory: (entry: MemoryEntry) =>
      request<MemoryEntry>(`memory/${encodeURIComponent(entry.id)}/withdraw`, {
        version: entry.version,
      }),
    pinMemory: (entry: MemoryEntry) =>
      request<MemoryEntry>(`memory/${encodeURIComponent(entry.id)}/pin`, {
        version: entry.version,
      }),
    artifacts: (taskId: string) =>
      request<Artifact[]>('artifacts?' + new URLSearchParams({ taskId })),
    events: (taskId: string, after = 0) =>
      request<EventEnvelope[]>(
        'events?' + new URLSearchParams({ taskId, after: String(after) }),
      ),
  };
}

export function connectRuntime(base: string, token: string) {
  async function req<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<T> {
    const res = await fetch(new URL(`/v1/${path}`, base), {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      const msgPart = data.error?.message ? `: ${data.error.message}` : '';
      throw Error(
        `${data.error?.code ?? res.status}${msgPart} (${data.error?.requestId ?? 'unknown'})`,
      );
    }
    return res.json() as Promise<T>;
  }
  return {
    overview: () => req<RuntimeOverview>('GET', 'runtime/overview'),
    sessions: () => req<{ items: RuntimeSession[] }>('GET', 'sessions'),
    createSession: (body: { title?: string; model?: string; workspaceRoot?: string; permissionMode?: string }) =>
      req<RuntimeSession>('POST', 'sessions', body),
    startTurn: (sessionId: string, body: { input: string; model?: string; permissionMode?: string; maxSteps?: number }) =>
      req<{ turn: RuntimeTurn; session: RuntimeSession }>('POST', `sessions/${encodeURIComponent(sessionId)}/turns`, body),
    receipts: (sessionId: string) =>
      req<{ items: ToolReceipt[] }>('GET', `sessions/${encodeURIComponent(sessionId)}/receipts`),
    reconciliations: (status = 'pending') =>
      req<{ items: ReconciliationItem[] }>('GET', `reconciliations?status=${encodeURIComponent(status)}`),
    resolveReconciliation: (id: string, outcome: 'happened' | 'not_applied' | 'abort', note = '') =>
      req<ReconciliationItem>('POST', `reconciliations/${encodeURIComponent(id)}/resolve`, { outcome, note }),
    swarmCapabilities: () =>
      req<{ models: unknown[]; archetypes: unknown[] }>('GET', 'swarm/capabilities'),
    swarmRuns: (sessionId?: string) =>
      req<{ items: SwarmRun[] }>('GET', sessionId ? `swarm/runs?sessionId=${encodeURIComponent(sessionId)}` : 'swarm/runs'),
    startSwarm: (body: { goal: string; sessionId?: string; maxConcurrency?: number; nodes?: unknown[]; wait?: boolean }) =>
      req<SwarmRun | SwarmSubmitResponse>('POST', 'swarm/runs', body),
    submitSwarmRun: (body: { goal: string; sessionId?: string; maxConcurrency?: number; nodes?: unknown[]; maxReplans?: number }) =>
      req<SwarmSubmitResponse>('POST', 'swarm/runs', body),
    getSwarmRun: (id: string) =>
      req<SwarmRun>('GET', `swarm/runs/${encodeURIComponent(id)}`),
    resumeSwarmRun: (id: string) =>
      req<SwarmRun>('POST', `swarm/runs/${encodeURIComponent(id)}/resume`),
    listSwarmReplans: (id: string) =>
      req<{ items: SwarmReplan[] }>('GET', `swarm/runs/${encodeURIComponent(id)}/replans`),
    listSwarmArtifacts: (runId: string, nodeKey?: string) =>
      req<{ items: SwarmArtifact[] }>(
        'GET',
        `swarm/runs/${encodeURIComponent(runId)}/artifacts${nodeKey ? `?nodeKey=${encodeURIComponent(nodeKey)}` : ''}`,
      ),
    getSwarmArtifact: (runId: string, artifactId: string, path?: string) =>
      req<SwarmArtifact | { artifactId: string; uri: string; entry: SwarmArtifactFileEntry; deleted: boolean; text?: string | null; base64?: string | null; verified: boolean }>(
        'GET',
        `swarm/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}${path ? `?path=${encodeURIComponent(path)}` : ''}`,
      ),
    verifySwarmArtifact: (runId: string, artifactId: string) =>
      req<SwarmArtifactVerifyResult>(
        'POST',
        `swarm/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}/verify`,
      ),
    applySwarmArtifact: (
      runId: string,
      artifactId: string,
      body?: { permissionMode?: string; approved?: boolean; targetWorkspaceRoot?: string },
    ) =>
      req<SwarmArtifactApplyResult>(
        'POST',
        `swarm/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}/apply`,
        body ?? {},
      ),
    listSessionNotifications: (sessionId: string, unreadOnly = false) =>
      req<{ items: ChildNotification[] }>(
        'GET',
        `sessions/${encodeURIComponent(sessionId)}/notifications${unreadOnly ? '?unreadOnly=true' : ''}`,
      ),
    schedules: () => req<{ items: ScheduledTask[] }>('GET', 'schedules'),
    getSchedule: (id: string) => req<ScheduledTask>('GET', `schedules/${encodeURIComponent(id)}`),
    createSchedule: (body: {
      name?: string;
      prompt: string;
      scheduleKind?: string;
      scheduleExpr?: string;
      timezone?: string;
      concurrencyPolicy?: string;
      misfirePolicy?: string;
      maxConcurrency?: number;
      workspaceRoot?: string | null;
      model?: string | null;
      permissionMode?: string;
      enabled?: boolean;
    }) => req<ScheduledTask>('POST', 'schedules', body),
    updateSchedule: (
      id: string,
      patch: Partial<{
        name: string;
        prompt: string;
        scheduleKind: string;
        scheduleExpr: string;
        timezone: string;
        concurrencyPolicy: string;
        misfirePolicy: string;
        maxConcurrency: number;
        workspaceRoot: string | null;
        model: string | null;
        permissionMode: string;
        enabled: boolean;
      }>,
    ) => req<ScheduledTask>('PATCH', `schedules/${encodeURIComponent(id)}`, patch),
    deleteSchedule: (id: string) =>
      req<{ id: string; deleted: boolean }>('DELETE', `schedules/${encodeURIComponent(id)}`),
    runSchedule: (id: string) =>
      req<{ schedule: ScheduledTask; run?: ScheduledTaskRun; session: RuntimeSession; turn: RuntimeTurn }>(
        'POST',
        `schedules/${encodeURIComponent(id)}/run`,
      ),
    listScheduleRuns: (id: string, limit = 50) =>
      req<{ items: ScheduledTaskRun[] }>('GET', `schedules/${encodeURIComponent(id)}/runs?limit=${limit}`),
    cancelScheduleRun: (id: string, runId: string) =>
      req<ScheduledTaskRun>('POST', `schedules/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}/cancel`),
    auditIntegrity: () => req<IntegrityReport>('GET', 'audit/integrity'),
  };
}
