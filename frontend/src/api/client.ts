import type {
  AccountBalance,
  Approval,
  Artifact,
  Assignment,
  BackendScheduleRecord,
  CheckinBridgeConfig,
  CheckinCenterResponse,
  CheckinRecordRow,
  ChildNotificationRecord,
  ConnectionSettings,
  EventEnvelope,
  EvaluationBenchmark,
  EvaluationRegressionSummary,
  EvaluationRun,
  EvaluationStartInput,
  Evidence,
  FileChangeDelta,
  GitStatus,
  MemoryItem,
  ModelSpec,
  ModelTestResult,
  NexusMemoryRecord,
  NexusModelsResponse,
  NexusUsageItem,
  NexusUsageResponse,
  PermissionMode,
  PoolModelsResponse,
  Project,
  ProviderAccount,
  ProviderAccountInput,
  ProviderAccountSyncResult,
  ProviderAccountTestResult,
  ProviderDirectory,
  ProviderPresetCatalog,
  ProvidersHealth,
  RuntimeOverviewRecord,
  ScheduleRunRecord,
  SessionHistoryItem,
  SessionRecord,
  Submission,
  SwarmArtifactRecord,
  SwarmReplanRecord,
  SwarmRunRecord,
  SwarmSubmitResponse,
  Task,
  TaskBundle,
  TaskPlan,
  ToolReceiptRecord,
  UsageItem,
  Worker,
} from '../types/backend';
import { createRuntimeClient } from './runtimeClient';
import { normalizeLegacyWorkerRole, resolveWorkerIdFromPayload } from '../utils/worker';

export class ApiError extends Error {
  status: number;
  code: string;
  requestId?: string;

  constructor(status: number, code: string, message?: string, requestId?: string) {
    super(message || code);
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

export interface AgentBackendClient {
  readonly isDemo: boolean;
  health(): Promise<{
    ok: boolean;
    status?: string;
    version?: string;
    uptimeMs?: number;
    workspaceRoot?: string;
    routerReady?: boolean;
    gateway?: { running: boolean; port: number; endpoint: string };
  }>;
  getWorkspace?: () => Promise<{ workspaceRoot: string }>;
  setWorkspace?: (workspaceRoot: string) => Promise<{ workspaceRoot: string }>;
  listProjects(): Promise<Project[]>;
  createProject(name: string): Promise<Project>;
  renameProject(id: string, name: string, version: number): Promise<Project>;
  listTasks(params?: { projectId?: string; limit?: number; offset?: number }): Promise<Task[]>;
  getTask(id: string): Promise<Task>;
  submitTask(submission: Submission): Promise<Task>;
  submitFollowupTurn?: (
    sessionId: string,
    input: string,
    opts?: {
      model?: string;
      permissionMode?: PermissionMode;
      effort?: string;
      files?: Record<string, string>;
      clientTurnId?: string;
    },
  ) => Promise<Task>;
  steerSession?: (
    sessionId: string,
    input: string,
  ) => Promise<{ steered: boolean; sessionId?: string; turnId?: string; queued?: number }>;
  compactSession?: (
    sessionId: string,
  ) => Promise<{ compacted: boolean; compressedCount?: number; summary?: string; reason?: string }>;
  rewindSession?: (
    sessionId: string,
    opts?: { turnId?: string; scope?: 'code' | 'conversation' | 'both' },
  ) => Promise<{ ok: boolean; restoredFiles: string[]; removedMessages: number; scope: string }>;
  searchHistory?: (
    query: string,
    limit?: number,
  ) => Promise<{ items: Array<{ sessionId: string; sessionTitle: string; role: string; snippet: string; createdAt: number }> }>;
  controlTask(
    id: string,
    action: 'pause' | 'resume' | 'cancel' | 'retry',
    version: number,
  ): Promise<Task>;
  listApprovals(params?: { taskId?: string; projectId?: string }): Promise<Approval[]>;
  decideApproval(
    id: string,
    version: number,
    decision: 'approve' | 'deny',
    scope?: 'once' | 'session',
  ): Promise<Approval>;
  resolveReconciliation?: (
    id: string,
    outcome: 'happened' | 'not_applied' | 'abort',
    note?: string,
  ) => Promise<Record<string, unknown>>;
  getRuntimeOverview?: () => Promise<RuntimeOverviewRecord>;
  getSessionReceipts?: (sessionId: string) => Promise<ToolReceiptRecord[]>;
  listSwarmRuns?: (params?: { sessionId?: string; limit?: number }) => Promise<SwarmRunRecord[]>;
  submitSwarmRun?: (input: {
    goal: string;
    sessionId?: string;
    workspaceRoot?: string;
    permissionMode?: string;
    maxConcurrency?: number;
    budget?: Record<string, unknown>;
    nodes?: unknown[];
    maxReplans?: number;
    wait?: boolean;
  }) => Promise<SwarmSubmitResponse>;
  getSwarmRun?: (id: string) => Promise<SwarmRunRecord>;
  resumeSwarmRun?: (id: string) => Promise<SwarmRunRecord>;
  listSwarmReplans?: (id: string) => Promise<SwarmReplanRecord[]>;
  listSwarmArtifacts?: (
    runId: string,
    params?: { nodeKey?: string; limit?: number },
  ) => Promise<SwarmArtifactRecord[]>;
  getSwarmArtifact?: (
    runId: string,
    artifactId: string,
    path?: string,
  ) => Promise<SwarmArtifactRecord | Record<string, unknown>>;
  verifySwarmArtifact?: (
    runId: string,
    artifactId: string,
  ) => Promise<{ ok: boolean; artifactId: string; bundleSha256?: string; reasons?: string[] }>;
  applySwarmArtifact?: (
    runId: string,
    artifactId: string,
    input?: { permissionMode?: string; approved?: boolean; targetWorkspaceRoot?: string },
  ) => Promise<Record<string, unknown>>;
  listSessionNotifications?: (sessionId: string, unreadOnly?: boolean) => Promise<ChildNotificationRecord[]>;
  listSchedules?: () => Promise<BackendScheduleRecord[]>;
  createSchedule?: (input: {
    name: string;
    prompt: string;
    scheduleKind: string;
    scheduleExpr: string;
    timezone?: string;
    concurrencyPolicy?: string;
    misfirePolicy?: string;
    maxConcurrency?: number;
    workspaceRoot?: string;
    model?: string;
    permissionMode?: string;
    enabled?: boolean;
  }) => Promise<BackendScheduleRecord>;
  updateSchedule?: (
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
  ) => Promise<BackendScheduleRecord>;
  deleteSchedule?: (id: string) => Promise<{ id: string; deleted: boolean }>;
  runScheduleNow?: (id: string) => Promise<{
    schedule: BackendScheduleRecord;
    run?: ScheduleRunRecord;
    session: { id: string };
    turn: { id: string };
  }>;
  listScheduleRuns?: (id: string, limit?: number) => Promise<ScheduleRunRecord[]>;
  cancelScheduleRun?: (id: string, runId: string) => Promise<ScheduleRunRecord>;
  listModels(): Promise<ModelSpec[]>;
  listProviders(): Promise<ProviderDirectory>;
  providersHealth(): Promise<ProvidersHealth>;
  getGitStatus?: () => Promise<GitStatus>;
  checkoutGitBranch?: (branch: string, create?: boolean) => Promise<GitStatus>;
  initGitRepo?: (initialBranch?: string) => Promise<GitStatus>;
  // Account Pool
  providerPresets?: () => Promise<ProviderPresetCatalog>;
  listAccounts?: (params?: {
    preset?: string;
    model?: string;
    enabled?: boolean;
    rateLimited?: boolean;
    search?: string;
  }) => Promise<ProviderAccount[]>;
  createAccount?: (input: ProviderAccountInput) => Promise<ProviderAccount>;
  updateAccount?: (id: string, patch: Partial<ProviderAccountInput>) => Promise<ProviderAccount>;
  deleteAccount?: (id: string) => Promise<{ id: string; deleted: boolean }>;
  batchAccounts?: (
    ids: string[],
    action: 'enable' | 'disable' | 'delete' | 'clear-cooldown',
  ) => Promise<{ action: string; affected: string[]; count: number }>;
  setProviderPriorities?: (order: string[]) => Promise<{ order: string[] }>;
  testAccount?: (id: string) => Promise<ProviderAccountTestResult>;
  syncAccountModels?: (id: string) => Promise<ProviderAccountSyncResult>;
  queryAccountBalance?: (id: string) => Promise<{ account: ProviderAccount; balance: AccountBalance }>;
  queryAllBalances?: () => Promise<{ items: Array<{ account: ProviderAccount; balance: AccountBalance }> }>;
  importLocalAccounts?: (paths?: string[]) => Promise<{ items: ProviderAccount[] }>;
  // Self-Contained Web Login & Local Credential Import
  scanLocalCredentials?: () => Promise<{
    items: Array<{
      id: string;
      preset: string;
      label: string;
      filePath: string;
      extractedKey: string;
      maskedToken: string | null;
    }>;
  }>;
  importLocalCredential?: (input: {
    id: string;
    autoSync?: boolean;
  }) => Promise<{
    ok: boolean;
    account: ProviderAccount;
    extractedKey: string;
    format: string;
    syncedModelsCount: number;
  }>;
  startWebLogin?: (input: {
    preset: string;
    autoSync?: boolean;
  }) => Promise<{
    ok: boolean;
    flowId?: string;
    engine?: 'openrouter-pkce' | 'github-device' | 'portal-token';
    preset?: string;
    authUrl?: string;
    state?: string;
    userCode?: string;
    verificationUri?: string;
    interval?: number;
    expiresIn?: number;
    instructions?: string;
    message?: string;
  }>;
  getWebLoginStatus?: (flowId: string) => Promise<{
    status: 'pending' | 'done' | 'failed' | 'canceled';
    userCode?: string;
    hint?: string;
    error?: string;
    message?: string;
    account?: ProviderAccount;
    syncedModelsCount?: number;
  }>;
  submitWebLoginCallback?: (
    flowId: string,
    input: { callbackUrl?: string; token?: string; label?: string; endpoint?: string },
  ) => Promise<{
    ok: boolean;
    status?: string;
    account?: ProviderAccount;
    syncedModelsCount?: number;
  }>;
  cancelWebLogin?: (flowId: string) => Promise<{ ok: boolean }>;
  importCredentialFile?: (input: {
    preset: string;
    label?: string;
    endpoint?: string;
    fileName?: string;
    content: string;
    autoSync?: boolean;
  }) => Promise<{
    ok: boolean;
    account: ProviderAccount;
    extractedKey: string;
    format: string;
    syncedModelsCount: number;
  }>;
  // Model Management Center
  getPoolModels?: (params?: {
    preset?: string;
    status?: string;
    visibility?: string;
    search?: string;
  }) => Promise<PoolModelsResponse>;
  syncProviderModels?: (
    preset?: string,
  ) => Promise<{ syncedAccounts: number; totalAccounts: number; results: Array<Record<string, unknown>> }>;
  addManualModel?: (input: {
    preset?: string;
    accountId?: string;
    upstreamModel: string;
    displayName?: string;
    contextWindow?: number;
    maxOutput?: number;
    multiplier?: number;
  }) => Promise<Record<string, unknown>>;
  updatePoolModel?: (
    id: string,
    patch: {
      enabled?: boolean;
      visible?: boolean;
      multiplier?: number;
      contextWindow?: number;
      maxOutput?: number;
      capabilities?: Record<string, boolean>;
    },
  ) => Promise<{ id: string; updated: boolean }>;
  deletePoolModel?: (id: string) => Promise<{ id: string; deleted: boolean }>;
  upsertModelMapping?: (input: {
    id?: string;
    alias: string;
    targetPreset?: string | null;
    targetAccountId?: string | null;
    targetModel: string;
    enabled?: boolean;
    isDefault?: boolean;
    priority?: number;
  }) => Promise<Record<string, unknown>>;
  deleteModelMapping?: (id: string) => Promise<{ id: string; deleted: boolean }>;
  setDefaultModel?: (model: string) => Promise<{ defaultModel: string }>;
  testModel?: (input: {
    model: string;
    accountId?: string;
    preset?: string;
  }) => Promise<ModelTestResult>;
  // Check-in Center
  getCheckinCenter?: () => Promise<CheckinCenterResponse>;
  runCheckin?: (input?: {
    accountId?: string;
    providerId?: string;
    section?: string;
  }) => Promise<Record<string, unknown>>;
  runCheckinActivity?: (accountId: string, mode: string) => Promise<Record<string, unknown>>;
  setAutoCheckin?: (enabled: boolean) => Promise<Record<string, unknown>>;
  saveCheckinSchedule?: (patch: Record<string, unknown>) => Promise<Record<string, unknown>>;
  deleteCheckinSchedule?: (id: string) => Promise<Record<string, unknown>>;
  runCheckinSchedule?: (id: string) => Promise<Record<string, unknown>>;
  getCheckinRecords?: (params?: {
    outcome?: string;
    kind?: string;
    provider?: string;
    keyword?: string;
    offset?: number;
    limit?: number;
  }) => Promise<{ records: CheckinRecordRow[]; total: number }>;
  clearCheckinRecords?: (all?: boolean) => Promise<{ removed: number }>;
  getCheckinBridge?: () => Promise<CheckinBridgeConfig>;
  saveCheckinBridge?: (input: {
    mode: 'auto' | 'bridge' | 'local';
    baseUrl?: string;
    apiKey?: string;
    panelToken?: string;
  }) => Promise<CheckinBridgeConfig>;
  testCheckinBridge?: () => Promise<{
    ok: boolean;
    connected: boolean;
    baseUrl?: string;
    latencyMs?: number;
    providersCount?: number;
    error?: string;
  }>;
  // Evaluation / Memory / Usage / Events
  listBenchmarks?: () => Promise<EvaluationBenchmark[]>;
  listEvaluationRuns?: (params?: { benchmarkId?: string; limit?: number }) => Promise<EvaluationRun[]>;
  getEvaluationRun?: (id: string) => Promise<EvaluationRun>;
  startEvaluation?: (input: EvaluationStartInput) => Promise<EvaluationRun>;
  getEvaluationRegression?: (params: {
    benchmarkId: string;
    baselineRunId?: string;
    candidateRunId?: string;
  }) => Promise<EvaluationRegressionSummary>;
  listMemory(params?: {
    projectId?: string;
    taskId?: string;
    scope?: string;
    sessionId?: string;
    q?: string;
    kind?: string;
    limit?: number;
  }): Promise<MemoryItem[]>;
  saveMemory?(
    input: Record<string, unknown>,
    params?: { scope?: string; sessionId?: string },
  ): Promise<NexusMemoryRecord>;
  deleteMemory?(
    key: string,
    params?: { scope?: string; sessionId?: string },
  ): Promise<{ key: string; deleted: boolean }>;
  listUsage(params?: {
    projectId?: string;
    taskId?: string;
    sessionId?: string;
    planId?: string;
    provider?: string;
    model?: string;
    accountId?: string;
    day?: string;
    fromDay?: string;
    toDay?: string;
  }): Promise<UsageItem[]>;
  listNexusUsage?(params?: Record<string, string | undefined>): Promise<NexusUsageResponse>;
  getTaskVersion(id: string, version: number): Promise<Task>;
  listEvents(params?: { taskId?: string; projectId?: string; after?: number }): Promise<EventEnvelope[]>;
  loadTaskBundle(taskId: string): Promise<TaskBundle>;
  subscribeEvents(
    params: { taskId?: string; projectId?: string; after?: number },
    onEvent: (ev: EventEnvelope) => void,
    onStatus?: (state: 'connected' | 'reconnecting' | 'error') => void,
  ): () => void;
}

type Query = Record<string, string | number | undefined>;

function buildUrl(baseUrl: string, path: string, query?: Query): string {
  const cleanBase = baseUrl.replace(/\/+$/, '');
  const prefix = cleanBase ? `${cleanBase}${path}` : path;
  if (!query) return prefix;
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== '') sp.set(key, String(value));
  }
  const qs = sp.toString();
  return qs ? `${prefix}?${qs}` : prefix;
}

function modelSpec(
  alias: string,
  provider: string,
  model: string,
  profile?: Record<string, unknown>,
): ModelSpec {
  const caps = (profile?.capabilities ?? {}) as Record<string, unknown>;
  return {
    provider,
    model: alias || model,
    design: 0.82,
    coding: 0.85,
    math: caps.reasoning ? 0.9 : 0.72,
    research: 0.8,
    speed: 0.8,
    context: Number(profile?.contextWindow ?? 128000),
    tools: caps.tools !== false,
    inputRate: 0,
    outputRate: 0,
  };
}

function mapMemory(item: NexusMemoryRecord): MemoryItem {
  return {
    id: `${item.scope.id}:${item.key}`,
    version: 1,
    projectId: null,
    taskId: item.scope.type === 'session' ? item.scope.id : null,
    summary: item.value,
    ...item,
  } as MemoryItem;
}

function mapUsage(item: NexusUsageItem): UsageItem {
  return {
    id: `${item.day}:${item.provider ?? 'unknown'}:${item.model ?? 'unknown'}:${item.sessionId ?? ''}`,
    version: 1,
    projectId: null,
    taskId: null,
    sessionId: item.sessionId ?? '',
    provider: item.provider ?? '',
    model: item.model ?? '',
    inputTokens: item.tokens,
    outputTokens: 0,
    estimatedUSD: item.costUsd,
  };
}

function mapEvent(value: Record<string, unknown>): EventEnvelope {
  const payload = (
    value.data && typeof value.data === 'object' ? value.data : value
  ) as Record<string, unknown>;
  const resolvedTaskId =
    (typeof value.taskId === 'string' && value.taskId) ||
    (typeof payload.taskId === 'string' && payload.taskId) ||
    (typeof payload.sessionId === 'string' && payload.sessionId) ||
    (typeof value.sessionId === 'string' && value.sessionId) ||
    null;
  return {
    seq: Number(value.seq ?? 0),
    timestamp: Number(value.at ?? value.timestamp ?? Date.now()),
    type: String(value.type ?? 'runtime.event'),
    projectId: null,
    taskId: resolvedTaskId,
    payload,
  };
}

function mapApproval(value: Record<string, unknown>): Approval {
  const id = String(value.id ?? 'approval');
  const status =
    value.status === 'allowed'
      ? 'approve'
      : value.status === 'denied'
        ? 'deny'
        : String(value.status ?? 'pending');
  return {
    id,
    version: 1,
    projectId: null,
    taskId: typeof value.sessionId === 'string' ? value.sessionId : null,
    workerId: typeof value.workerId === 'string' ? value.workerId : '',
    assignmentId: '',
    jobId: typeof value.turnId === 'string' ? value.turnId : undefined,
    callId: typeof value.callId === 'string' ? value.callId : undefined,
    kind: value.kind === 'reconciliation' ? 'reconciliation' : 'tool',
    receiptId: typeof value.receiptId === 'string' ? value.receiptId : undefined,
    riskLevel: typeof value.riskLevel === 'string' ? value.riskLevel : undefined,
    effectClass: typeof value.effectClass === 'string' ? value.effectClass : undefined,
    outcome: typeof value.outcome === 'string' ? value.outcome : undefined,
    status: status as Approval['status'],
    action: (
      value.arguments && typeof value.arguments === 'object' ? value.arguments : {}
    ) as Record<string, unknown>,
    tool: String(value.tool ?? ''),
    digest: '',
    expires: Number(value.expiresAt ?? 0),
    nexus: value,
  } as Approval;
}

export class LiveBackendClient implements AgentBackendClient {
  readonly isDemo = false;
  private baseUrl: string;
  private token: string;
  private defaultModel = '';
  private workspaceRoot = '';
  private readonly rt = createRuntimeClient((m, p, o) => this.req(m, p, o));

  constructor(settings: ConnectionSettings) {
    this.baseUrl = settings.baseUrl.trim().replace(/\/v1\/?$/, '');
    this.token = settings.token.trim();
  }

  private headers(hasBody = false): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (hasBody) headers['Content-Type'] = 'application/json';
    return headers;
  }

  private async req<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    path: string,
    options?: { body?: unknown; query?: Query; signal?: AbortSignal },
  ): Promise<T> {
    const response = await fetch(buildUrl(this.baseUrl, path, options?.query), {
      method,
      headers: this.headers(options?.body !== undefined),
      body: options?.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options?.signal,
    });
    if (!response.ok) {
      let code = `HTTP_${response.status}`;
      let message: string | undefined;
      let requestId: string | undefined;
      try {
        const data = (await response.json()) as {
          error?: { code?: string; message?: string; requestId?: string };
        };
        code = data.error?.code ?? code;
        message = data.error?.message;
        requestId = data.error?.requestId;
      } catch {
        /* non-JSON response */
      }
      throw new ApiError(response.status, code, message, requestId);
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  async health() {
    const data = await this.req<{
      ok?: boolean;
      status?: string;
      version?: string;
      uptimeMs?: number;
      workspaceRoot?: string;
      routerReady?: boolean;
      gateway?: { running: boolean; port: number; endpoint: string };
    }>('GET', '/v1/health');
    if (data.workspaceRoot) this.workspaceRoot = data.workspaceRoot;
    return { ...data, ok: data.ok ?? data.status === 'ok' };
  }

  async getWorkspace() {
    const data = await this.req<{ workspaceRoot: string }>('GET', '/v1/workspace');
    this.workspaceRoot = data.workspaceRoot;
    return data;
  }

  async setWorkspace(workspaceRoot: string) {
    const data = await this.req<{ workspaceRoot: string }>('PUT', '/v1/workspace', {
      body: { workspaceRoot },
    });
    this.workspaceRoot = data.workspaceRoot;
    return data;
  }

  async listProjects(): Promise<Project[]> {
    const wsName = this.workspaceRoot
      ? this.workspaceRoot.split(/[\\/]/).filter(Boolean).pop() || 'Workspace'
      : 'Agent_US Workspace';
    return [
      {
        id: 'workspace',
        version: 1,
        projectId: null,
        taskId: null,
        name: wsName,
        workspaceRoot: this.workspaceRoot || undefined,
      },
    ];
  }

  async createProject(name: string): Promise<Project> {
    return {
      id: 'workspace',
      version: 1,
      projectId: null,
      taskId: null,
      name: name || 'Agent_US Workspace',
      workspaceRoot: this.workspaceRoot || undefined,
    };
  }

  async renameProject(_id: string, name: string, version: number): Promise<Project> {
    return { id: 'workspace', version: version + 1, projectId: null, taskId: null, name };
  }

  private taskFromSession(
    session: Record<string, unknown>,
    turn?: Record<string, unknown> | null,
  ): Task {
    const state = String(turn?.state ?? session.state ?? 'idle');
    const status: Task['status'] =
      state === 'running'
        ? 'running'
        : state === 'failed'
          ? 'failed'
          : state === 'cancelled'
            ? 'cancelled'
            : state === 'completed'
              ? 'completed'
              : 'completed';
    const rawVerdict =
      turn?.verdict && typeof turn.verdict === 'object'
        ? (turn.verdict as Record<string, unknown>)
        : null;
    const verdict =
      rawVerdict !== null
        ? {
            accepted: Boolean(rawVerdict.accepted),
            reason: Array.isArray(rawVerdict.reasons) && rawVerdict.reasons.length
              ? rawVerdict.reasons.map(String).join('；')
              : String(rawVerdict.reason ?? (rawVerdict.accepted ? '已通过验证' : '验证未通过')),
            verdict: typeof rawVerdict.verdict === 'string' ? rawVerdict.verdict : undefined,
            reasons: Array.isArray(rawVerdict.reasons) ? rawVerdict.reasons.map(String) : undefined,
            evidenceCount: Number(turn?.evidenceCount ?? rawVerdict.evidenceCount ?? 0),
          }
        : typeof turn?.error === 'string' && turn.error
          ? { accepted: false, reason: turn.error }
          : undefined;
    const input = String(session.title ?? turn?.input ?? '新对话');
    return {
      id: String(session.id),
      version: 1,
      projectId: 'workspace',
      taskId: null,
      input,
      status,
      phase: typeof turn?.phase === 'string' ? turn.phase : undefined,
      evidenceCount: Number(turn?.evidenceCount ?? verdict?.evidenceCount ?? 0),
      createdAt: Number(session.createdAt ?? Date.now()),
      files: {},
      code: typeof turn?.id === 'string' ? turn.id : undefined,
      model: typeof session.model === 'string' ? session.model : undefined,
      workspaceRoot: typeof session.workspaceRoot === 'string' ? session.workspaceRoot : undefined,
      livePlan:
        session.plan && typeof session.plan === 'object'
          ? (session.plan as Task['livePlan'])
          : null,
      ...(verdict ? { verdict } : {}),
    };
  }

  async listTasks(params?: {
    projectId?: string;
    limit?: number;
    offset?: number;
  }): Promise<Task[]> {
    if (params?.projectId && params.projectId !== 'workspace') return [];
    const page = await this.req<{ items?: Record<string, unknown>[] }>('GET', '/v1/sessions', {
      query: { limit: params?.limit ?? 200 },
    });
    return (page.items ?? []).map((session) => this.taskFromSession(session, null));
  }

  async getTask(id: string): Promise<Task> {
    const [session, turns] = await Promise.all([
      this.req<Record<string, unknown>>('GET', `/v1/sessions/${encodeURIComponent(id)}`),
      this.req<{ items?: Record<string, unknown>[] }>(
        'GET',
        `/v1/sessions/${encodeURIComponent(id)}/turns`,
        { query: { limit: 1 } },
      ),
    ]);
    return this.taskFromSession(session, turns.items?.[0] ?? null);
  }

  async submitTask(submission: Submission): Promise<Task> {
    let model = submission.model || this.defaultModel;
    if (!model) {
      const catalog = await this.req<NexusModelsResponse>('GET', '/v1/models');
      model = catalog.defaultModel || catalog.items[0]?.alias || '';
      this.defaultModel = model;
    }
    const session = await this.req<Record<string, unknown>>('POST', '/v1/sessions', {
      body: {
        title: submission.input.slice(0, 120),
        model,
        permissionMode: submission.permissionMode ?? 'auto-safe',
        ...(submission.workspaceRoot ? { workspaceRoot: submission.workspaceRoot } : {}),
      },
    });
    const turnRes = await this.req<{ turn?: Record<string, unknown> }>(
      'POST',
      `/v1/sessions/${encodeURIComponent(String(session.id))}/turns`,
      {
        body: {
          input: submission.input,
          clientTurnId: submission.idempotencyKey,
          model,
          permissionMode: submission.permissionMode ?? 'auto-safe',
          ...(submission.effort ? { effort: submission.effort } : {}),
          ...(submission.files && Object.keys(submission.files).length
            ? { files: submission.files }
            : {}),
          ...(submission.budget?.maxSteps ? { maxSteps: submission.budget.maxSteps } : {}),
        },
      },
    );
    return this.taskFromSession(session, turnRes.turn ?? null);
  }

  async submitFollowupTurn(
    sessionId: string,
    input: string,
    opts?: {
      model?: string;
      permissionMode?: PermissionMode;
      effort?: string;
      files?: Record<string, string>;
      clientTurnId?: string;
    },
  ): Promise<Task> {
    const turnRes = await this.req<{
      turn?: Record<string, unknown>;
      session?: Record<string, unknown>;
    }>('POST', `/v1/sessions/${encodeURIComponent(sessionId)}/turns`, {
      body: {
        input,
        clientTurnId: opts?.clientTurnId ?? `turn-${Date.now()}`,
        ...(opts?.model ? { model: opts.model } : {}),
        ...(opts?.permissionMode ? { permissionMode: opts.permissionMode } : {}),
        ...(opts?.effort ? { effort: opts.effort } : {}),
        ...(opts?.files && Object.keys(opts.files).length ? { files: opts.files } : {}),
      },
    });
    return this.taskFromSession(
      turnRes.session ?? { id: sessionId, title: input },
      turnRes.turn ?? null,
    );
  }

  steerSession(sessionId: string, input: string) {
    return this.req<{ steered: boolean; sessionId?: string; turnId?: string; queued?: number }>(
      'POST',
      `/v1/sessions/${encodeURIComponent(sessionId)}/steer`,
      { body: { input } },
    );
  }

  compactSession(sessionId: string) {
    return this.req<{ compacted: boolean; compressedCount?: number; summary?: string; reason?: string }>(
      'POST',
      `/v1/sessions/${encodeURIComponent(sessionId)}/compact`,
    );
  }

  rewindSession(
    sessionId: string,
    opts?: { turnId?: string; scope?: 'code' | 'conversation' | 'both' },
  ) {
    return this.req<{ ok: boolean; restoredFiles: string[]; removedMessages: number; scope: string }>(
      'POST',
      `/v1/sessions/${encodeURIComponent(sessionId)}/rewind`,
      { body: opts ?? { scope: 'both' } },
    );
  }

  searchHistory(query: string, limit = 20) {
    return this.req<{
      items: Array<{ sessionId: string; sessionTitle: string; role: string; snippet: string; createdAt: number }>;
    }>('GET', '/v1/history/search', { query: { q: query, limit } });
  }

  async controlTask(
    id: string,
    action: 'pause' | 'resume' | 'cancel' | 'retry',
    _version: number,
  ): Promise<Task> {
    if (action === 'cancel' || action === 'pause') {
      const turns = await this.req<{ items?: Record<string, unknown>[] }>(
        'GET',
        `/v1/sessions/${encodeURIComponent(id)}/turns`,
        { query: { limit: 1 } },
      );
      const turnId = turns.items?.[0]?.id;
      if (typeof turnId === 'string') {
        await this.req('POST', `/v1/turns/${encodeURIComponent(turnId)}/cancel`);
      }
    } else if (action === 'resume' || action === 'retry') {
      const turns = await this.req<{ items?: Array<{ input?: string }> }>(
        'GET',
        `/v1/sessions/${encodeURIComponent(id)}/turns`,
        { query: { limit: 1 } },
      );
      const prompt = turns.items?.[0]?.input ?? '继续';
      await this.req('POST', `/v1/sessions/${encodeURIComponent(id)}/turns`, {
        body: { input: prompt, clientTurnId: `${action}-${Date.now()}` },
      });
    }
    return this.getTask(id);
  }

  async listApprovals(params?: { taskId?: string; projectId?: string }): Promise<Approval[]> {
    const data = await this.req<{ items?: Record<string, unknown>[] }>('GET', '/v1/approvals', {
      query: { status: 'pending', sessionId: params?.taskId, limit: 200 },
    });
    return (data.items ?? []).map(mapApproval);
  }

  async decideApproval(
    id: string,
    _version: number,
    decision: 'approve' | 'deny',
    scope: 'once' | 'session' = 'once',
  ): Promise<Approval> {
    const value = await this.req<Record<string, unknown>>(
      'POST',
      `/v1/approvals/${encodeURIComponent(id)}/decision`,
      { body: { decision: decision === 'approve' ? 'allow' : 'deny', scope } },
    );
    return mapApproval(value);
  }

  resolveReconciliation(
    id: string,
    outcome: 'happened' | 'not_applied' | 'abort',
    note = '',
  ) {
    return this.rt.resolveReconciliation(id, outcome, note);
  }

  getRuntimeOverview() {
    return this.rt.getOverview();
  }

  getSessionReceipts(sessionId: string) {
    return this.rt.getSessionReceipts(sessionId);
  }

  listSwarmRuns(params?: { sessionId?: string; limit?: number }) {
    return this.rt.listSwarmRuns(params);
  }

  submitSwarmRun(input: Parameters<typeof this.rt.submitSwarmRun>[0]) {
    return this.rt.submitSwarmRun(input);
  }

  getSwarmRun(id: string) {
    return this.rt.getSwarmRun(id);
  }

  resumeSwarmRun(id: string) {
    return this.rt.resumeSwarmRun(id);
  }

  listSwarmReplans(id: string) {
    return this.rt.listSwarmReplans(id);
  }

  listSwarmArtifacts(runId: string, params?: { nodeKey?: string; limit?: number }) {
    return this.rt.listSwarmArtifacts(runId, params);
  }

  getSwarmArtifact(runId: string, artifactId: string, path?: string) {
    return this.rt.getSwarmArtifact(runId, artifactId, path);
  }

  verifySwarmArtifact(runId: string, artifactId: string) {
    return this.rt.verifySwarmArtifact(runId, artifactId);
  }

  applySwarmArtifact(
    runId: string,
    artifactId: string,
    input?: { permissionMode?: string; approved?: boolean; targetWorkspaceRoot?: string },
  ) {
    return this.rt.applySwarmArtifact(runId, artifactId, input);
  }

  listSessionNotifications(sessionId: string, unreadOnly = false) {
    return this.rt.listSessionNotifications(sessionId, unreadOnly);
  }

  listSchedules() {
    return this.rt.listSchedules();
  }

  createSchedule(input: {
    name: string;
    prompt: string;
    scheduleKind: string;
    scheduleExpr: string;
    timezone?: string;
    concurrencyPolicy?: string;
    misfirePolicy?: string;
    maxConcurrency?: number;
    workspaceRoot?: string;
    model?: string;
    permissionMode?: string;
    enabled?: boolean;
  }) {
    return this.rt.createSchedule(input);
  }

  updateSchedule(
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
  ) {
    return this.rt.updateSchedule(id, patch);
  }

  deleteSchedule(id: string) {
    return this.rt.deleteSchedule(id);
  }

  runScheduleNow(id: string) {
    return this.rt.runScheduleNow(id);
  }

  listScheduleRuns(id: string, limit = 50) {
    return this.rt.listScheduleRuns(id, limit);
  }

  cancelScheduleRun(id: string, runId: string) {
    return this.rt.cancelScheduleRun(id, runId);
  }

  async listModels(): Promise<ModelSpec[]> {
    const data = await this.req<NexusModelsResponse | ModelSpec[]>('GET', '/v1/models');
    if (Array.isArray(data)) return data;
    this.defaultModel = data.defaultModel || data.items[0]?.alias || '';
    const seen = new Set<string>();
    const list: ModelSpec[] = [];
    for (const item of data.items) {
      const first = item.targets[0];
      if (!first) continue;
      const key = `${first.provider}/${item.alias}`;
      if (seen.has(key)) continue;
      seen.add(key);
      list.push(modelSpec(item.alias, first.provider, first.model, data.profiles?.[item.alias]));
    }
    return list;
  }

  async listProviders(): Promise<ProviderDirectory> {
    return this.req('GET', '/v1/providers');
  }

  async providersHealth(): Promise<ProvidersHealth> {
    const data = await this.req<{
      routerReady: boolean;
      items?: ProviderAccount[];
      providers?: ProvidersHealth['providers'];
    }>('GET', '/v1/providers/health');
    return { routerReady: data.routerReady, items: data.items ?? [], providers: data.providers };
  }

  getGitStatus(): Promise<GitStatus> {
    return this.req('GET', '/v1/git/status');
  }

  checkoutGitBranch(branch: string, create = false): Promise<GitStatus> {
    return this.req('POST', '/v1/git/checkout', { body: { branch, create } });
  }

  initGitRepo(initialBranch = 'main'): Promise<GitStatus> {
    return this.req('POST', '/v1/git/init', { body: { initialBranch } });
  }

  // ---- Account Pool ----

  providerPresets(): Promise<ProviderPresetCatalog> {
    return this.req('GET', '/v1/providers/presets');
  }

  async listAccounts(params?: {
    preset?: string;
    model?: string;
    enabled?: boolean;
    rateLimited?: boolean;
    search?: string;
  }): Promise<ProviderAccount[]> {
    const data = await this.req<{ items?: ProviderAccount[] }>('GET', '/v1/accounts', {
      query: {
        preset: params?.preset,
        model: params?.model,
        enabled: params?.enabled === undefined ? undefined : String(params.enabled),
        rateLimited: params?.rateLimited === undefined ? undefined : String(params.rateLimited),
        search: params?.search,
      },
    });
    return data.items ?? [];
  }

  createAccount(input: ProviderAccountInput): Promise<ProviderAccount> {
    return this.req('POST', '/v1/accounts', { body: input });
  }

  updateAccount(id: string, patch: Partial<ProviderAccountInput>): Promise<ProviderAccount> {
    return this.req('PATCH', `/v1/accounts/${encodeURIComponent(id)}`, { body: patch });
  }

  deleteAccount(id: string): Promise<{ id: string; deleted: boolean }> {
    return this.req('DELETE', `/v1/accounts/${encodeURIComponent(id)}`);
  }

  batchAccounts(ids: string[], action: 'enable' | 'disable' | 'delete' | 'clear-cooldown') {
    return this.req<{ action: string; affected: string[]; count: number }>(
      'POST',
      '/v1/accounts/batch',
      { body: { ids, action } },
    );
  }

  setProviderPriorities(order: string[]) {
    return this.req<{ order: string[] }>('PUT', '/v1/accounts/priorities', { body: { order } });
  }

  testAccount(id: string): Promise<ProviderAccountTestResult> {
    return this.req('POST', `/v1/accounts/${encodeURIComponent(id)}/test`);
  }

  syncAccountModels(id: string): Promise<ProviderAccountSyncResult> {
    return this.req('POST', `/v1/accounts/${encodeURIComponent(id)}/sync-models`);
  }

  queryAccountBalance(id: string) {
    return this.req<{ account: ProviderAccount; balance: AccountBalance }>(
      'POST',
      `/v1/accounts/${encodeURIComponent(id)}/balance`,
    );
  }

  queryAllBalances() {
    return this.req<{ items: Array<{ account: ProviderAccount; balance: AccountBalance }> }>(
      'POST',
      '/v1/accounts/balances',
    );
  }

  importLocalAccounts(paths: string[] = []): Promise<{ items: ProviderAccount[] }> {
    return this.req('POST', '/v1/accounts/import-local', { body: { paths } });
  }

  scanLocalCredentials() {
    return this.req<{
      items: Array<{
        id: string;
        preset: string;
        label: string;
        filePath: string;
        extractedKey: string;
        maskedToken: string | null;
      }>;
    }>('GET', '/v1/auth/local-credentials');
  }

  importLocalCredential(input: { id: string; autoSync?: boolean }) {
    return this.req<{
      ok: boolean;
      account: ProviderAccount;
      extractedKey: string;
      format: string;
      syncedModelsCount: number;
    }>('POST', '/v1/auth/import-local', { body: input });
  }

  startWebLogin(input: {
    preset: string;
    autoSync?: boolean;
  }) {
    return this.req<{
      ok: boolean;
      flowId?: string;
      engine?: 'openrouter-pkce' | 'github-device' | 'portal-token';
      preset?: string;
      authUrl?: string;
      state?: string;
      userCode?: string;
      verificationUri?: string;
      interval?: number;
      expiresIn?: number;
      instructions?: string;
      message?: string;
    }>('POST', '/v1/auth/web-login/start', {
      body: {
        ...input,
        callbackOrigin: typeof window !== 'undefined' ? window.location.origin : undefined,
      },
    });
  }

  getWebLoginStatus(flowId: string) {
    return this.req<{
      status: 'pending' | 'done' | 'failed' | 'canceled';
      userCode?: string;
      hint?: string;
      error?: string;
      message?: string;
      account?: ProviderAccount;
      syncedModelsCount?: number;
    }>('GET', `/v1/auth/web-login/${encodeURIComponent(flowId)}/status`);
  }

  submitWebLoginCallback(
    flowId: string,
    input: { callbackUrl?: string; token?: string; label?: string; endpoint?: string },
  ) {
    return this.req<{
      ok: boolean;
      status?: string;
      account?: ProviderAccount;
      syncedModelsCount?: number;
    }>('POST', `/v1/auth/web-login/${encodeURIComponent(flowId)}/callback`, { body: input });
  }

  cancelWebLogin(flowId: string) {
    return this.req<{ ok: boolean }>(
      'POST',
      `/v1/auth/web-login/${encodeURIComponent(flowId)}/cancel`,
      { body: {} },
    );
  }

  importCredentialFile(input: {
    preset: string;
    label?: string;
    endpoint?: string;
    fileName?: string;
    content: string;
    autoSync?: boolean;
  }) {
    return this.req<{
      ok: boolean;
      account: ProviderAccount;
      extractedKey: string;
      format: string;
      syncedModelsCount: number;
    }>('POST', '/v1/auth/import-credential', { body: input });
  }

  // ---- Model Management Center ----

  getPoolModels(params?: {
    preset?: string;
    status?: string;
    visibility?: string;
    search?: string;
  }): Promise<PoolModelsResponse> {
    return this.req('GET', '/v1/models/pool', { query: params });
  }

  syncProviderModels(preset?: string) {
    return this.req<{
      syncedAccounts: number;
      totalAccounts: number;
      results: Array<Record<string, unknown>>;
    }>('POST', '/v1/models/sync', { body: { preset } });
  }

  addManualModel(input: {
    preset?: string;
    accountId?: string;
    upstreamModel: string;
    displayName?: string;
    contextWindow?: number;
    maxOutput?: number;
    multiplier?: number;
  }) {
    return this.req<Record<string, unknown>>('POST', '/v1/models/manual', { body: input });
  }

  updatePoolModel(
    id: string,
    patch: {
      enabled?: boolean;
      visible?: boolean;
      multiplier?: number;
      contextWindow?: number;
      maxOutput?: number;
      capabilities?: Record<string, boolean>;
    },
  ) {
    return this.req<{ id: string; updated: boolean }>(
      'PATCH',
      `/v1/models/${encodeURIComponent(id)}`,
      { body: patch },
    );
  }

  deletePoolModel(id: string) {
    return this.req<{ id: string; deleted: boolean }>(
      'DELETE',
      `/v1/models/${encodeURIComponent(id)}`,
    );
  }

  upsertModelMapping(input: {
    id?: string;
    alias: string;
    targetPreset?: string | null;
    targetAccountId?: string | null;
    targetModel: string;
    enabled?: boolean;
    isDefault?: boolean;
    priority?: number;
  }) {
    return this.req<Record<string, unknown>>('POST', '/v1/models/mappings', { body: input });
  }

  deleteModelMapping(id: string) {
    return this.req<{ id: string; deleted: boolean }>(
      'DELETE',
      `/v1/models/mappings/${encodeURIComponent(id)}`,
    );
  }

  setDefaultModel(model: string) {
    return this.req<{ defaultModel: string }>('PUT', '/v1/models/default', { body: { model } });
  }

  testModel(input: { model: string; accountId?: string; preset?: string }) {
    return this.req<ModelTestResult>('POST', '/v1/models/test', { body: input });
  }

  // ---- Check-in Center ----

  getCheckinCenter(): Promise<CheckinCenterResponse> {
    return this.req('GET', '/v1/checkin/center');
  }

  runCheckin(input?: { accountId?: string; providerId?: string; section?: string }) {
    return this.req<Record<string, unknown>>('POST', '/v1/checkin/run', { body: input ?? {} });
  }

  runCheckinActivity(accountId: string, mode: string) {
    return this.req<Record<string, unknown>>('POST', '/v1/checkin/activity', {
      body: { accountId, mode },
    });
  }

  setAutoCheckin(enabled: boolean) {
    return this.req<Record<string, unknown>>('POST', '/v1/checkin/auto', { body: { enabled } });
  }

  saveCheckinSchedule(patch: Record<string, unknown>) {
    return this.req<Record<string, unknown>>('POST', '/v1/checkin/schedules', { body: patch });
  }

  deleteCheckinSchedule(id: string) {
    return this.req<Record<string, unknown>>(
      'DELETE',
      `/v1/checkin/schedules/${encodeURIComponent(id)}`,
    );
  }

  runCheckinSchedule(id: string) {
    return this.req<Record<string, unknown>>(
      'POST',
      `/v1/checkin/schedules/${encodeURIComponent(id)}/run`,
    );
  }

  getCheckinRecords(params?: {
    outcome?: string;
    kind?: string;
    provider?: string;
    keyword?: string;
    offset?: number;
    limit?: number;
  }) {
    return this.req<{ records: CheckinRecordRow[]; total: number }>('GET', '/v1/checkin/records', {
      query: params,
    });
  }

  clearCheckinRecords(all = true) {
    return this.req<{ removed: number }>('DELETE', '/v1/checkin/records', {
      query: all ? { all: '1' } : undefined,
    });
  }

  getCheckinBridge(): Promise<CheckinBridgeConfig> {
    return this.req('GET', '/v1/checkin/bridge');
  }

  saveCheckinBridge(input: {
    mode: 'auto' | 'bridge' | 'local';
    baseUrl?: string;
    apiKey?: string;
    panelToken?: string;
  }): Promise<CheckinBridgeConfig> {
    return this.req('PUT', '/v1/checkin/bridge', { body: input });
  }

  testCheckinBridge() {
    return this.req<{
      ok: boolean;
      connected: boolean;
      baseUrl?: string;
      latencyMs?: number;
      providersCount?: number;
      error?: string;
    }>('POST', '/v1/checkin/bridge/test');
  }

  // ---- Evaluation / Memory & Usage ----

  async listBenchmarks(): Promise<EvaluationBenchmark[]> {
    const data = await this.req<{ items?: EvaluationBenchmark[] } | EvaluationBenchmark[]>(
      'GET',
      '/v1/benchmarks',
    );
    return Array.isArray(data) ? data : (data.items ?? []);
  }

  async listEvaluationRuns(params?: { benchmarkId?: string; limit?: number }): Promise<EvaluationRun[]> {
    const data = await this.req<{ items?: EvaluationRun[] } | EvaluationRun[]>(
      'GET',
      '/v1/evaluations',
      { query: params },
    );
    return Array.isArray(data) ? data : (data.items ?? []);
  }

  getEvaluationRun(id: string): Promise<EvaluationRun> {
    return this.req("GET", `/v1/evaluations/${encodeURIComponent(id)}`);
  }

  async startEvaluation(input: EvaluationStartInput): Promise<EvaluationRun> {
    const data = await this.req<EvaluationRun | { run: EvaluationRun }>(
      'POST',
      '/v1/evaluations',
      { body: input },
    );
    return 'run' in data ? data.run : data;
  }

  getEvaluationRegression(params: {
    benchmarkId: string;
    baselineRunId?: string;
    candidateRunId?: string;
  }): Promise<EvaluationRegressionSummary> {
    return this.req('GET', '/v1/evaluations/regression', { query: params });
  }

  async listMemory(params?: {
    projectId?: string;
    taskId?: string;
    scope?: string;
    sessionId?: string;
    q?: string;
    kind?: string;
    limit?: number;
  }): Promise<MemoryItem[]> {
    const data = await this.req<{ items?: NexusMemoryRecord[] } | MemoryItem[]>(
      'GET',
      '/v1/memory',
      {
        query: {
          scope: params?.scope,
          sessionId: params?.sessionId,
          q: params?.q,
          kind: params?.kind,
          limit: params?.limit ?? 200,
        },
      },
    );
    return Array.isArray(data) ? data : (data.items ?? []).map(mapMemory);
  }

  saveMemory(
    input: Record<string, unknown>,
    params?: { scope?: string; sessionId?: string },
  ): Promise<NexusMemoryRecord> {
    return this.req('PUT', '/v1/memory', {
      query: { scope: params?.scope ?? 'global', sessionId: params?.sessionId },
      body: input,
    });
  }

  deleteMemory(
    key: string,
    params?: { scope?: string; sessionId?: string },
  ): Promise<{ key: string; deleted: boolean }> {
    return this.req('DELETE', '/v1/memory', {
      query: { scope: params?.scope ?? 'global', sessionId: params?.sessionId, key },
    });
  }

  async listUsage(params?: {
    projectId?: string;
    taskId?: string;
    sessionId?: string;
    planId?: string;
    provider?: string;
    model?: string;
    accountId?: string;
    day?: string;
    fromDay?: string;
    toDay?: string;
  }): Promise<UsageItem[]> {
    const data = await this.req<NexusUsageResponse | UsageItem[]>('GET', '/v1/usage', {
      query: params,
    });
    return Array.isArray(data) ? data : data.items.map(mapUsage);
  }

  listNexusUsage(params?: Record<string, string | undefined>): Promise<NexusUsageResponse> {
    return this.req('GET', '/v1/usage', { query: params });
  }

  getTaskVersion(id: string, _version: number): Promise<Task> {
    return this.getTask(id);
  }

  async listEvents(params?: {
    taskId?: string;
    projectId?: string;
    after?: number;
  }): Promise<EventEnvelope[]> {
    if (params?.taskId) {
      const data = await this.req<{ items?: Record<string, unknown>[] }>(
        'GET',
        `/v1/sessions/${encodeURIComponent(params.taskId)}/events`,
        { query: { after: params.after ?? 0, limit: 300 } },
      );
      return (data.items ?? []).map(mapEvent);
    }
    return [];
  }

  async loadTaskBundle(taskId: string): Promise<TaskBundle> {
    const [task, messages, rawEvents, approvals, usage, receipts, swarmRuns] = await Promise.all([
      this.getTask(taskId),
      this.req<{ items?: Array<Record<string, unknown>> }>(
        'GET',
        `/v1/sessions/${encodeURIComponent(taskId)}/messages`,
        { query: { after: 0, limit: 300 } },
      ),
      this.listEvents({ taskId, after: 0 }),
      this.listApprovals({ taskId }),
      this.listUsage({ sessionId: taskId }),
      this.rt.getSessionReceipts(taskId).catch(() => [] as ToolReceiptRecord[]),
      this.rt.listSwarmRuns({ sessionId: taskId, limit: 10 }).catch(() => [] as SwarmRunRecord[]),
    ]);

    const events = [...rawEvents].sort((a, b) => {
      if (a.seq > 0 && b.seq > 0 && a.seq !== b.seq) return a.seq - b.seq;
      return a.timestamp - b.timestamp;
    });

    // Hydrate real Evidence (tool calls + results + workspace file diffs) from DirectAgent events
    const evidence: Evidence[] = [];
    const pendingChanges: FileChangeDelta[] = [];
    for (const ev of events) {
      const p = ev.payload ?? {};
      if (ev.type === 'file/changed' && typeof p.path === 'string') {
        pendingChanges.push({
          path: p.path,
          before: typeof p.before === 'string' ? p.before : null,
          after: typeof p.after === 'string' ? p.after : null,
        });
      } else if (ev.type === 'tool/result') {
        const toolName = String(p.name ?? 'tool');
        const isEdit = toolName === 'edit_file' || toolName === 'write_file';
        const changes = isEdit && pendingChanges.length ? pendingChanges.splice(0) : undefined;
        evidence.push({
          id: String(p.callId || `ev-${ev.seq}`),
          version: 1,
          projectId: 'workspace',
          taskId,
          status: p.isError ? 'failed' : 'finished',
          tool: toolName,
          workerId: taskId,
          assignmentId: 'direct',
          path: changes?.[0]?.path,
          digest: String(ev.seq),
          exitCode: p.isError ? 1 : 0,
          stdout: typeof p.output === 'string' ? p.output : '',
          changes,
        });
      }
    }
    if (pendingChanges.length) {
      evidence.push({
        id: `changes-${taskId}`,
        version: 1,
        projectId: 'workspace',
        taskId,
        status: 'finished',
        tool: 'edit_file',
        workerId: taskId,
        assignmentId: 'direct',
        path: pendingChanges[0].path,
        digest: 'changes',
        changes: pendingChanges,
      });
    }

    // Reconcile durable tool_receipts into Evidence[] (authoritative status/exitCode/outcome_unknown)
    const evByCallId = new Map(evidence.map((e) => [e.id, e]));
    for (const r of receipts) {
      const existing = evByCallId.get(r.callId);
      const rStatus: Evidence['status'] =
        r.status === 'outcome_unknown'
          ? 'outcome_unknown'
          : r.status === 'failed'
            ? 'failed'
            : r.status === 'executing'
              ? 'executing'
              : 'finished';
      if (existing) {
        existing.status = rStatus;
        if (typeof r.exitCode === 'number') existing.exitCode = r.exitCode;
      } else {
        evidence.push({
          id: r.callId || r.id,
          version: 1,
          projectId: 'workspace',
          taskId,
          status: rStatus,
          tool: r.toolName,
          workerId: taskId,
          assignmentId: 'direct',
          digest: r.id,
          exitCode: r.exitCode ?? undefined,
        });
      }
    }

    const session: SessionRecord = {
      id: taskId,
      version: 1,
      projectId: 'workspace',
      taskId,
      workerId: taskId,
      assignmentId: 'direct',
      role: 'Coder',
      status:
        task.status === 'running'
          ? 'running'
          : task.status === 'failed'
            ? 'failed'
            : 'done',
    };

    const historyItems: SessionHistoryItem[] = (messages.items ?? []).map((msg, index) => {
      const role = String(msg.role ?? 'user');
      const type: SessionHistoryItem['type'] =
        role === 'assistant'
          ? 'assistant/message'
          : role === 'tool'
            ? 'tool/result'
            : 'user/message';
      return {
        cursor: Number(msg.seq ?? index),
        sessionId: taskId,
        turnId: typeof msg.turnId === 'string' ? msg.turnId : undefined,
        type,
        sequence: Number(msg.seq ?? index),
        text: String(msg.content ?? ''),
        reasoning: typeof msg.reasoning === 'string' ? msg.reasoning : undefined,
        name: typeof msg.toolName === 'string' ? msg.toolName : undefined,
        callId: typeof msg.toolCallId === 'string' ? msg.toolCallId : undefined,
        meta:
          msg.meta && typeof msg.meta === 'object'
            ? (msg.meta as Record<string, unknown>)
            : undefined,
      };
    });

    // Hydrate adaptive Swarm workers & DAG assignments + legacy worker fallback
    const workers: Worker[] = [];
    const assignments: Assignment[] = [];
    const hydratedPlan: TaskPlan | undefined = task.plan;
    const seenWorker = new Set<string>();
    for (const run of swarmRuns) {
      for (const n of run.nodes ?? []) {
        const wStatus: Worker['status'] =
          n.status === 'running'
            ? 'running'
            : n.status === 'failed'
              ? 'failed'
              : n.status === 'cancelled'
                ? 'interrupted'
                : 'done';
        const wid = n.childSessionId || `${run.id}:${n.nodeKey}`;
        assignments.push({
          id: n.id,
          version: 1,
          projectId: 'workspace',
          taskId,
          key: n.nodeKey,
          role: normalizeLegacyWorkerRole(n.agentProfileId),
          workerName: n.nodeKey,
          workerRole: n.agentProfileId,
          objective: n.objective,
          acceptance: n.acceptance,
          dependencies: n.dependencies ?? [],
          status:
            n.status === 'running'
              ? 'running'
              : n.status === 'failed' || n.status === 'cancelled'
                ? 'failed'
                : n.status === 'completed'
                  ? 'done'
                  : 'waiting',
          workerId: wid,
        });
        if (!seenWorker.has(wid)) {
          seenWorker.add(wid);
          workers.push({
            id: wid,
            version: 1,
            projectId: 'workspace',
            taskId,
            jobId: run.id,
            model: n.model || task.model || this.defaultModel,
            provider: n.provider || 'pool',
            assignmentId: n.id,
            role: normalizeLegacyWorkerRole(n.agentProfileId),
            workerName: n.nodeKey,
            workerRole: n.agentProfileId,
            status: wStatus,
            attempt: 1,
          });
        }
      }
    }
    for (const ev of events) {
      const resolvedKey = resolveWorkerIdFromPayload(ev.payload ?? {});
      if (resolvedKey && !seenWorker.has(resolvedKey) && ev.payload?.workerRole !== 'router') {
        seenWorker.add(resolvedKey);
        workers.push({
          id: resolvedKey,
          version: 1,
          projectId: 'workspace',
          taskId,
          jobId: taskId,
          model: task.model || this.defaultModel,
          provider: 'pool',
          assignmentId: null,
          role: normalizeLegacyWorkerRole(
            typeof ev.payload?.workerRole === 'string' ? ev.payload.workerRole : undefined,
          ),
          status: task.status === 'running' ? 'running' : 'done',
          attempt: 1,
        });
      }
    }

    return {
      task: hydratedPlan ? { ...task, plan: hydratedPlan } : task,
      assignments,
      workers,
      sessions: [session],
      histories: { [taskId]: historyItems },
      approvals,
      evidence,
      artifacts: [] as Artifact[],
      usage,
      events,
    };
  }

  subscribeEvents(
    params: { taskId?: string; projectId?: string; after?: number },
    onEvent: (ev: EventEnvelope) => void,
    onStatus?: (state: 'connected' | 'reconnecting' | 'error') => void,
  ): () => void {
    let closed = false;
    let lastSeq = params.after ?? 0;
    let controller: AbortController | null = null;
    let retryTimer: number | null = null;
    let backoff = 500;
    const connect = async () => {
      if (closed) return;
      controller = new AbortController();
      try {
        const path = params.taskId
          ? `/v1/sessions/${encodeURIComponent(params.taskId)}/stream`
          : '/v1/stream';
        const response = await fetch(buildUrl(this.baseUrl, path, { after: lastSeq }), {
          headers: {
            ...this.headers(),
            Accept: 'text/event-stream',
            ...(lastSeq > 0 ? { 'Last-Event-ID': String(lastSeq) } : {}),
          },
          signal: controller.signal,
        });
        if (!response.ok || !response.body) throw new Error(`SSE HTTP ${response.status}`);
        backoff = 500;
        onStatus?.('connected');
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (!closed) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split(/\r?\n\r?\n/);
          buffer = frames.pop() ?? '';
          for (const frame of frames) {
            if (!frame.trim() || frame.trim().startsWith(':')) continue;
            let dataText = '';
            let eventId = '';
            for (const line of frame.split(/\r?\n/)) {
              if (line.startsWith('id:')) eventId = line.slice(3).trim();
              if (line.startsWith('data:')) dataText += line.slice(5).trim();
            }
            if (!dataText) continue;
            try {
              const raw = JSON.parse(dataText) as Record<string, unknown>;
              const event = mapEvent(raw);
              // Deliver live streaming deltas immediately (ephemeral frames have seq === 0)
              if (
                raw.ephemeral === true ||
                event.type === 'assistant/delta' ||
                event.type === 'reasoning/delta' ||
                event.type === 'tool/output'
              ) {
                onEvent(event);
                continue;
              }
              const seq = event.seq || Number(eventId);
              if (seq > lastSeq) {
                event.seq = seq;
                lastSeq = seq;
                onEvent(event);
              }
            } catch {
              /* ignore malformed SSE frame */
            }
          }
        }
      } catch {
        if (!closed) onStatus?.('reconnecting');
      }
      if (!closed) {
        retryTimer = window.setTimeout(connect, backoff);
        backoff = Math.min(backoff * 1.8, 8000);
      }
    };
    void connect();
    return () => {
      closed = true;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      controller?.abort();
    };
  }
}
