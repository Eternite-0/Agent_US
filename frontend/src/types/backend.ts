export type TaskStatus =
  | 'planning'
  | 'running'
  | 'reviewing'
  | 'completed'
  | 'failed'
  | 'paused'
  | 'cancelled';

export type WorkerRole = 'Researcher' | 'Planner' | 'Coder' | 'Reviewer' | 'Tester';

export interface Entity {
  id: string;
  version: number;
  projectId: string | null;
  taskId: string | null;
}

export interface Project extends Entity {
  name: string;
  workspaceRoot?: string;
}

export interface Budget {
  maxSteps?: number;
  maxDurationSeconds?: number;
  maxCostUSD?: number;
}

export interface GitStatus {
  workspaceRoot?: string;
  available: boolean;
  branch: string | null;
  dirty: boolean;
  uncommittedCount?: number;
  branches?: string[];
  ahead?: number;
  behind?: number;
}

export interface Submission {
  projectId: string | null;
  input: string;
  idempotencyKey: string;
  files?: Record<string, string>;
  budget?: Budget;
  model?: string;
  permissionMode?: PermissionMode;
  effort?: EffortLevel;
  workspaceRoot?: string;
}

export interface LivePlanStep {
  id: string;
  title: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export interface LivePlanState {
  explanation?: string;
  steps: LivePlanStep[];
  updatedAt?: number;
}

export interface PlanNode {
  key: string;
  role: WorkerRole;
  /** Router-generated presentation name; never used as a scheduling identity. */
  workerName?: string;
  workerRole?: string;
  objective: string;
  acceptance: string;
  dependencies: string[];
  requiredFiles?: string[];
}

export interface TaskPlan {
  type: string;
  complexity: 'simple' | 'medium' | 'complex';
  risk: 'low' | 'medium' | 'high';
  nodes: PlanNode[];
}

export interface TaskVerdict {
  accepted: boolean;
  reason: string;
  verdict?: string;
  reasons?: string[];
  evidenceCount?: number;
}

export interface ChatHistoryMatch {
  seq: number;
  sessionId: string;
  sessionTitle: string;
  role: string;
  snippet: string;
  createdAt: number;
  archivedAt?: number | null;
}

export interface Task extends Entity {
  input: string;
  status: TaskStatus;
  archivedAt?: number | null;
  phase?: string;
  evidenceCount?: number;
  previousStatus?: TaskStatus;
  createdAt?: number;
  budget?: Budget;
  files?: Record<string, string>;
  plan?: TaskPlan;
  verdict?: TaskVerdict;
  revision?: number;
  feedback?: string;
  code?: string;
  model?: string;
  workspaceRoot?: string;
  permissionMode?: SessionPermissionMode;
  livePlan?: LivePlanState | null;
}

export interface Assignment extends Entity, PlanNode {
  status: 'waiting' | 'queued' | 'running' | 'done' | 'failed';
  workerId?: string;
}

export interface Worker extends Entity {
  role: WorkerRole;
  workerName?: string;
  workerRole?: string;
  activityLabel?: string;
  jobId: string;
  model: string;
  provider: string;
  assignmentId: string | null;
  status: 'waiting' | 'running' | 'parked' | 'reconciling' | 'done' | 'failed' | 'interrupted' | 'cancelled' | 'unknown';
  attempt: number;
  code?: string;
}

export interface SessionRecord extends Entity {
  workerId: string;
  workerName?: string;
  workerRole?: string;
  assignmentId: string | null;
  role: WorkerRole;
  status: 'running' | 'done' | 'failed' | 'interrupted';
  code?: string;
}

export interface SessionHistoryItem {
  cursor: number;
  sessionId: string;
  turnId?: string;
  type:
    | 'user/message'
    | 'assistant/message'
    | 'tool/call'
    | 'tool/result'
    | 'turn/start'
    | 'turn/end'
    | 'step/start';
  sequence: number;
  text?: string;
  reasoning?: string;
  toolCalls?: Array<{ id: string; name: string; arguments?: string | Record<string, unknown> }>;
  name?: string;
  callId?: string;
  meta?: Record<string, unknown>;
}

export interface Approval extends Entity {
  workerId: string;
  assignmentId: string;
  jobId?: string;
  fence?: string;
  callId?: string;
  kind?: 'tool' | 'reconciliation';
  receiptId?: string;
  riskLevel?: string;
  effectClass?: string;
  outcome?: string;
  policy?: number;
  status: 'pending' | 'approve' | 'deny' | 'revoked' | 'consumed' | 'expired';
  action: Record<string, unknown>;
  tool: string;
  digest: string;
  expires: number;
  nexus?: Record<string, unknown>;
}

export interface FileChangeDelta {
  path: string;
  before: string | null; // base64 or null
  after: string | null; // base64 or null
  action?: 'create' | 'update' | 'delete' | string;
  unifiedDiff?: string;
  additions?: number;
  deletions?: number;
  sha256After?: string | null;
}

export interface AciBudgetWatermarks {
  usedTokens?: number;
  maxTokens?: number;
  utilizationRatio?: number;
  ratio?: number;
  reserveTokens?: number;
  postTestReserveActive?: boolean;
  dtocWatermark?: number;
  dtocMinPromptTokens?: number;
  dtocPolicy?: string | null;
  projectedTotalTokens?: number;
  supervisorCircuitOpen?: boolean;
  circuitOpenUntil?: number | null;
}

export interface AciAdmissionDecisions {
  DIRECT: number;
  SUPPORTING: number;
  DEFER: number;
  DUPLICATE: number;
  IRRELEVANT: number;
}

export interface AciTurnTelemetry {
  turnId?: string;
  aciProfile?: string | null;
  dtocPolicy?: string | null;
  admissionDecisions: AciAdmissionDecisions;
  admissionTokensSaved: number;
  partialRecoveries: number;
  fullRecoveries: number;
  recoveryTokensSaved: number;
  supersededEvictions: number;
  supersededTokensSaved: number;
  trajectoryTriggeredEpochs: number;
  antiThrashingTriggered?: number;
  supervisorCircuitOpen?: boolean;
  supervisorCalls?: number;
  budgetWatermarks?: AciBudgetWatermarks | null;
}

export interface DiagnosticEntry {
  file: string;
  line: number;
  column?: number;
  severity: 'error' | 'warning' | 'info' | string;
  code?: string;
  message: string;
  source?: string;
  testName?: string;
  expected?: string;
  actual?: string;
  operator?: string;
}

export interface FailingTestEntry {
  name: string;
  testName?: string;
  file?: string;
  line?: number;
  column?: number;
  assertion?: string;
  expected?: string;
  actual?: string;
  operator?: string;
}

export interface ParsedDiagnosticsSummary {
  ok?: boolean;
  kind?: string;
  diagnostics: DiagnosticEntry[];
  failingTests: FailingTestEntry[];
  compression?: {
    rawLines: number;
    keptLines: number;
    truncatedCount: number;
  };
}

export interface Evidence extends Entity {
  status: 'executing' | 'finished' | 'failed' | 'outcome_unknown';
  tool: string;
  workerId: string;
  assignmentId: string;
  approvalId?: string;
  path?: string;
  digest: string;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  changes?: FileChangeDelta[];
}

export interface Artifact extends Entity {
  key?: string;
  workerId?: string;
  assignmentId: string;
  text: string;
  files: Record<string, string>; // relative path -> base64
  published: boolean;
}

export interface MemoryItem extends Entity {
  summary: string;
  scope?: { type: string; id: string };
  key?: string;
  value?: string;
  kind?: string;
  tags?: string[];
  confidence?: number;
  createdAt?: number;
  updatedAt?: number;
  lastAccessedAt?: number | null;
}

export interface UsageItem extends Entity {
  sessionId: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  estimatedUSD: number;
  tokens?: number;
  costUsd?: number;
  costUsdMicros?: number;
  durationMs?: number;
  callCount?: number;
  day?: string;
  planId?: string | null;
  accountId?: string | null;
}

export interface ModelSpec {
  provider: string;
  model: string;
  design: number;
  coding: number;
  math: number;
  research: number;
  speed: number;
  context: number;
  tools: boolean;
  inputRate: number;
  outputRate: number;
}

export interface ProviderInfo {
  id: string;
  configured: boolean;
  discovery: { ok: boolean; ids: string[] } | null;
  magpieReady: boolean;
}

export interface ProviderPresetField {
  name: string;
  label?: string;
  type: 'string' | 'object';
  secret: boolean;
  required: boolean;
}

export interface ProviderCategorySpec {
  id: string;
  label: string;
}

export interface ProviderPreset {
  id: string;
  name?: string;
  category?: string;
  kind: string;
  protocol: string;
  ownedBy: string;
  icon?: string;
  color?: string;
  description?: string;
  defaultEndpoint: string | null;
  supportsBalance?: boolean;
  supportsCheckin?: boolean;
  accountCount?: number;
  /** How the frontend can connect this provider without inventing unsupported OAuth flows. */
  loginMode?: 'web' | 'file' | 'manual';
  nativeLogin?: boolean;
  /** Optional stable URL shown when the user needs to obtain a key/token. */
  officialUrl?: string;
  fields: ProviderPresetField[];
}

export interface ProviderPresetCatalog {
  categories?: ProviderCategorySpec[];
  items: Record<string, ProviderPreset>;
}

export interface AccountBalance {
  supported: boolean;
  amount?: number | null;
  currency?: string;
  unit?: string;
  display: string;
  error?: string;
  checkedAt?: number;
}

export interface ProviderAccount {
  id: string;
  preset: string;
  presetName?: string;
  category?: string;
  protocol?: string;
  label: string;
  priority: number;
  providerRank?: number;
  enabled: boolean;
  models: string[];
  endpoint: string | null;
  proxyUrl?: string | null;
  headers: Record<string, string>;
  modelProfiles: Record<string, Record<string, unknown>>;
  status: string;
  rateLimited?: boolean;
  cooldownUntil: number;
  cooldownRemainingMs?: number;
  lastError: string | null;
  lastErrorAt: number | null;
  lastSuccessAt: number | null;
  balance?: AccountBalance | null;
  expiresAt?: number | null;
  activeConns?: number;
  modelCount: number;
  /** Masked by the backend; never a plaintext credential. */
  credential?: string | null;
  meta?: Record<string, unknown>;
}

export interface ProviderAccountInput {
  id?: string;
  preset: string;
  label?: string;
  category?: string;
  protocol?: string;
  priority?: number;
  enabled?: boolean;
  models?: string[];
  endpoint?: string | null;
  proxyUrl?: string | null;
  headers?: Record<string, string>;
  credential?: string;
  apiKey?: string;
  token?: string;
  cookie?: string;
  expiresAt?: number | null;
  clearCooldown?: boolean;
  meta?: Record<string, unknown>;
}

export interface ProviderAccountTestResult extends ProviderAccount {
  ok: boolean;
  latencyMs: number;
  error?: string;
  discoveredCount?: number;
}

export interface ProviderAccountSyncResult {
  account: ProviderAccount;
  models: Array<Record<string, unknown>>;
  latencyMs: number;
}

export interface ModelMappingItem {
  id: string;
  alias: string;
  targetPreset: string | null;
  targetAccountId: string | null;
  targetModel: string;
  enabled: boolean;
  isDefault: boolean;
  priority: number;
}

export interface PoolModelCapabilities {
  tools?: boolean;
  reasoning?: boolean;
  vision?: boolean;
  cache?: boolean;
}

export interface PoolModelItem {
  id: string;
  ids: string[];
  preset: string;
  presetName: string;
  providerRank: number;
  upstreamModel: string;
  displayName: string;
  enabled: boolean;
  visible: boolean;
  source: 'remote' | 'manual' | string;
  multiplier: number;
  contextWindow: number;
  maxOutput: number;
  capabilities: PoolModelCapabilities;
  accountIds: string[];
  activeAccountCount: number;
  mappings: ModelMappingItem[];
}

export interface PoolProviderSidebarItem {
  id: string;
  name: string;
  icon: string;
  color: string;
  category: string;
  rank: number;
  modelCount: number;
}

export interface PoolModelsResponse {
  totalCount: number;
  enabledCount: number;
  mappedCount: number;
  defaultModel: string;
  providers: PoolProviderSidebarItem[];
  items: PoolModelItem[];
  unmountedMappings: ModelMappingItem[];
  gateway?: {
    running: boolean;
    host: string;
    port: number;
    endpoint: string;
  };
}

export interface ModelTestResult {
  ok: boolean;
  latencyMs: number;
  reply?: string;
  error?: string;
  accountId?: string;
  provider?: string;
  wireModel?: string;
}

// ---- Check-in Center (Agent2API protocol) ----

export interface CheckinDailyState {
  at: number;
  completed: boolean;
  completedCount: number;
  totalCount: number;
  sourcesComplete?: boolean;
  status?: string;
  message?: string;
}

export interface CheckinAccountItem {
  id: string;
  name: string;
  available: boolean;
  checkinAt: number | null;
  checkedInToday: boolean;
  dailyCheckin?: CheckinDailyState | null;
  edition?: string | null;
  streakDays: number;
}

export interface CheckinProviderGroup {
  id: string;
  label: string;
  description?: string | null;
  accounts: CheckinAccountItem[];
  doneCount: number;
  totalCount: number;
  modes?: string[] | null;
}

export interface CheckinScheduleEntry {
  id: string;
  label: string;
  displayLabel: string;
  enabled: boolean;
  time: string;
  timeEnd?: string;
  providers: string[];
  providerTimes?: Record<string, string>;
  retryTime: string;
  retryGapMinutes: number;
  retryLimit: number;
  lastFiredDate: string | null;
  lastFiredToday: boolean;
  retryCount: number;
}

export interface CheckinRecordRow {
  rowId?: number;
  ts: number;
  date?: string;
  accountId?: string;
  accountName?: string;
  provider?: string;
  providerId?: string;
  source?: string;
  outcome?: string;
  reason?: string;
  message?: string;
  error?: string;
  points?: number;
}

export interface CheckinBridgeConfig {
  mode: 'auto' | 'bridge' | 'local';
  baseUrl: string;
  hasApiKey: boolean;
  hasPanelToken: boolean;
  source?: string;
  connected?: boolean;
  error?: string | null;
}

export interface CheckinCenterResponse {
  mode: 'bridge' | 'local';
  bridge: CheckinBridgeConfig;
  daily: {
    providers: CheckinProviderGroup[];
    outOfScope: Array<{ label: string; reason: string; count: number }>;
    todayDone: number;
    todayEligible: number;
  };
  extras: {
    onboarding: Array<{ id: string; name: string; provider: string; settled?: unknown }>;
    plans: Array<{ id: string; name: string; provider: string; claimAt?: number | null }>;
    growth: Array<{ id: string; name: string; provider: string }>;
  };
  auto: {
    enabled: boolean;
    lastFiredToday: boolean;
    running: boolean;
    providerOptions: Array<{ id: string; label: string }>;
    defaultRetryTime?: string;
    schedules: CheckinScheduleEntry[];
  };
  recordsTotal: number;
  plugins?: Array<{ kind: string; file: string; providerId: string; label: string; description: string }>;
}

export interface NexusModelTarget {
  provider: string;
  model: string;
}

export interface NexusModelAlias {
  alias: string;
  targets: NexusModelTarget[];
}

export interface NexusModelsResponse {
  defaultModel: string;
  items: NexusModelAlias[];
  profiles?: Record<string, Record<string, unknown>>;
}

export interface NexusMemoryRecord {
  scope: { type: string; id: string };
  key: string;
  value: string;
  kind?: string;
  tags?: string[];
  confidence?: number;
  createdAt?: number;
  updatedAt?: number;
  lastAccessedAt?: number | null;
  score?: number;
}

export interface NexusUsageItem {
  sessionId: string | null;
  planId: string | null;
  provider: string | null;
  model: string | null;
  accountId: string | null;
  day: string;
  tokens: number;
  costUsd: number;
  costUsdMicros?: number;
  durationMs: number;
  callCount: number;
}

export interface NexusUsageResponse {
  items: NexusUsageItem[];
  summary: Record<string, unknown>;
}

export interface ProviderDirectory {
  routerReady: boolean;
  items: ProviderAccount[];
}

export interface ProvidersHealth {
  routerReady: boolean;
  items: ProviderAccount[];
  providers?: ProviderInfo[];
}

export interface EventEnvelope {
  seq: number;
  timestamp: number;
  type: string;
  projectId: string | null;
  taskId: string | null;
  payload: Record<string, unknown>;
}

export interface TaskBundle {
  task: Task;
  assignments: Assignment[];
  workers: Worker[];
  sessions: SessionRecord[];
  histories: Record<string, SessionHistoryItem[]>;
  approvals: Approval[];
  evidence: Evidence[];
  artifacts: Artifact[];
  usage: UsageItem[];
  events: EventEnvelope[];
  swarmRuns?: SwarmRunRecord[];
}

export type ThemeMode = 'light' | 'dark' | 'system';

export type AppearancePreset =
  | 'codex'
  | 'linear'
  | 'vercel'
  | 'catppuccin'
  | 'tokyo-night'
  | 'github'
  | 'dracula'
  | 'nord'
  | 'rose-pine'
  | 'raycast';

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export type PermissionMode = 'approval' | 'auto-review' | 'full-access' | 'auto-safe';
export type SessionPermissionMode = PermissionMode | 'read-only' | 'workspace-write';
export type GitReviewInput = { sessionId?: string; expectedWorkspaceRoot?: string; baseBranch?: string; model?: string; effort?: EffortLevel };

export type AppView =
  | { kind: 'home' }
  | { kind: 'thread'; taskId: string; focusWorkerId?: string }
  | { kind: 'archived' }
  | { kind: 'tasks' }
  | { kind: 'capabilities'; section?: 'skills' | 'mcp'; sessionId?: string; pluginId?: string }
  | { kind: 'evaluations' }
  | { kind: 'settings'; section: string };

export type CodexMode = 'Codex' | 'Work' | 'Chat';

export type InspectorTab = 'subagents' | 'diff' | 'artifacts' | 'events' | 'autonomous' | 'git';

export interface ToastItem {
  id: string;
  message: string;
  tone?: 'default' | 'success' | 'warning' | 'danger';
  actionLabel?: string;
  onAction?: () => void;
}

export interface ConnectionSettings {
  mode: 'live' | 'demo';
  baseUrl: string;
  token: string;
}

export interface ToolReceiptRecord {
  id: string;
  sessionId: string;
  turnId: string;
  callId: string;
  toolName: string;
  riskLevel: string;
  effectClass: string;
  replayable: number;
  outward: number;
  status: 'executing' | 'finished' | 'failed' | 'outcome_unknown';
  exitCode?: number | null;
  durationMs: number;
  reconciliationOutcome?: string | null;
  createdAt: number;
}

export type WorkspaceEntryKind = 'file' | 'folder' | 'all';

export interface McpServerStatus {
  server: string;
  status: string;
  toolCount: number;
  lastCheckedAt: number;
}

export interface SwarmNodeRecord {
  id: string;
  attempts?: number;
  runId: string;
  nodeKey: string;
  agentProfileId: string;
  taskType?: string;
  roleTitle?: string | null;
  childSessionId?: string | null;
  model?: string | null;
  provider?: string | null;
  objective: string;
  acceptance: string;
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
  changeType?: string;
  path: string;
  status: string;
  previousPath?: string | null;
  sizeBytes?: number;
  mode?: string | null;
  binary?: boolean;
  sha256?: string | null;
  baseSha256?: string | null;
}

export interface SwarmArtifactRecord {
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

export interface SwarmArtifactFile {
  entry: SwarmArtifactFileEntry;
  deleted: boolean;
  text?: string | null;
  base64?: string | null;
  verified: boolean;
}

export interface SwarmMessageRecord {
  messageId: string;
  fromAgentId: string;
  toAgentId: string;
  kind: string;
  status: string;
  artifactManifest?: { artifacts: { uri: string; sha256: string }[] };
  planVersion?: number;
  createdAt: number;
}

export interface SwarmRepoContext {
  branch?: string | null;
  headSha?: string | null;
  testCommands?: string[];
  buildCommands?: string[];
  entryPoints?: string[];
  relevantFiles?: string[];
  summaryText?: string | null;
}

export interface SwarmReviewerFinding {
  severity: string;
  message: string;
  evidenceRef?: string;
}

export interface SwarmReviewerVerification {
  verifiedGitDiff: boolean;
  diffFileCount: number;
  diffDigest?: string | null;
  verifiedTestExitCode: number | null;
  hardGatePassed: boolean;
  verdict?: string;
  reasons?: string[];
}

export interface SwarmReviewerVerdict {
  nodeKey: string;
  nodeStatus?: string;
  status: string;
  summary?: string;
  reviewerModel?: string;
  checkedArtifacts?: string[];
  evidenceRefs?: string[];
  findings?: SwarmReviewerFinding[];
  reviewerVerification?: SwarmReviewerVerification | null;
  validatedAt?: number;
}

export interface SwarmUsageSummary {
  steps?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  completedNodes?: number;
  replanCount?: number;
  reservedSteps?: number;
  reservedTokens?: number;
}

export interface SwarmRunVerdict {
  verdict: string;
  accepted: boolean;
  reasons?: string[];
  verificationMode?: string;
  evidenceCount?: number;
  reviewerVerdicts?: SwarmReviewerVerdict[];
  reviewerVerification?: SwarmReviewerVerification | null;
  independentReviewerVerdict?: {
    status: string;
    source?: string;
    reviewerModels?: string[];
    evidenceRefs?: string[];
    evidenceDigests?: string[];
  };
}

export interface SwarmDeliveryChangedFile {
  path: string;
  changeType: string;
  previousPath?: string | null;
  sha256?: string | null;
  nodeKey: string;
  artifactId: string;
  uri: string;
}

export interface SwarmDeliveryConflict {
  path: string;
  nodeKeys: string[];
  reason: string;
}

export interface SwarmDeliveryTestResult {
  nodeKey: string;
  command?: string;
  exitCode?: number | null;
  status: string;
  summary?: string;
}

export interface SwarmBudgetSnapshot {
  treeId?: string;
  updatedAt?: number;
  reservedSteps?: number;
  remainingSteps?: number | null;
  reservedTokens?: number;
  remainingTokens?: number | null;
}

export interface SwarmDeliveryRecord {
  runId: string;
  teamRationale?: string | null;
  budgetLedger?: SwarmBudgetSnapshot | null;
  status: string;
  goal: string;
  planVersion?: number;
  repoContext?: SwarmRepoContext | null;
  changedFiles?: SwarmDeliveryChangedFile[];
  conflicts?: SwarmDeliveryConflict[];
  unifiedDiffPreview?: string;
  testResults?: SwarmDeliveryTestResult[];
  reviewerVerdicts?: SwarmReviewerVerdict[];
  reviewerVerification?: SwarmReviewerVerification | null;
  verdict?: SwarmRunVerdict | null;
  usage?: SwarmUsageSummary & Record<string, unknown>;
  artifacts?: SwarmArtifactRecord[];
}

export interface SwarmApplyAllResult {
  ok: boolean;
  status: string;
  runId: string;
  appliedArtifacts?: unknown[];
  appliedFiles?: unknown[];
  conflicts?: unknown[];
  errors?: unknown[];
}

export interface SwarmRunRecord {
  id: string;
  plan?: { metadata?: { teamRationale?: string | null } | null } | null;
  sessionId: string;
  goal: string;
  status: string;
  planVersion?: number;
  currentPhase?: string;
  replanCount?: number;
  errorCode?: string | null;
  errorMessage?: string | null;
  repoContext?: SwarmRepoContext | null;
  strategy?: Record<string, unknown>;
  usage: SwarmUsageSummary & Record<string, unknown>;
  reviewerVerification?: SwarmReviewerVerification | null;
  verdict?: SwarmRunVerdict | null;
  nodes: SwarmNodeRecord[];
  createdAt: number;
  updatedAt: number;
}

export interface SwarmCommandReceipt {
  mode: 'swarm';
  ledger?: SwarmBudgetSnapshot | null;
  action: 'start' | 'status' | 'stop' | 'help';
  runId: string | null;
  run: SwarmRunRecord | null;
  message: string;
}

export interface SwarmSubmitResponse {
  runId: string;
  sessionId: string;
  status: string;
  run: SwarmRunRecord;
}

export interface SwarmReplanRecord {
  id: string;
  runId: string;
  version: number;
  failedNodeKey?: string | null;
  strategy: string;
  reason?: string | null;
  diff: Record<string, unknown>;
  createdAt: number;
}

export interface ChildNotificationRecord {
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

export interface ScheduleRunRecord {
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

export interface BackendScheduleRecord {
  id: string;
  name: string;
  prompt: string;
  scheduleKind: string;
  scheduleExpr: string;
  timezone?: string;
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
  createdAt: number;
  updatedAt?: number;
}

export interface RuntimeOverviewRecord {
  ok: boolean;
  activeTurns: number;
  pendingApprovals: number;
  pendingReconciliations: number;
  unknownReceipts: number;
  activeSwarmRuns: number;
  enabledSchedules: number;
  modelCount?: number;
}

export type EvaluationRunStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timeout';

export interface EvaluationBenchmark {
  id: string;
  title: string;
  version: string;
  datasetVersion: string;
  taskCount: number;
  categories: string[];
  tasks?: { id: string; title: string; category: string; difficulty: string }[];
  description?: string;
  updatedAt?: number;
}

export interface EvaluationScore {
  total: number;
  passed: number;
  failed: number;
  cancelled: number;
  timedOut: number;
  attempts: number;
  passRate: number;
  meanDurationMs: number;
  totalDurationMs: number;
}

export interface EvaluationTaskResult {
  taskId: string;
  status: EvaluationRunStatus | 'passed';
  passed: boolean;
  attempts: number;
  durationMs: number;
  error?: string;
  judge?: {
    deterministic?: boolean;
    reason?: string;
    score?: number;
  };
}

export interface EvaluationRun {
  id: string;
  benchmarkId: string;
  benchmarkVersion: string;
  datasetVersion: string;
  status: EvaluationRunStatus;
  agentVersion?: string;
  model?: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  cancelRequestedAt?: number | null;
  score?: EvaluationScore;
  results?: EvaluationTaskResult[];
  error?: string;
}

export interface EvaluationStartInput {
  benchmarkId: string;
  taskIds?: string[];
  model?: string;
  concurrency?: number;
  timeoutMs?: number;
  maxAttempts?: number;
}

export interface ModelCapabilityProfile {
  id: string;
  declared: { label: string; capabilities: Record<string, number> } | null;
  measured: {
    sampleCount: number;
    confidence: number;
    empiricalScore: number | null;
    capabilities: Record<string, number>;
    evaluation: { evaluationRunId: string; benchmarkVersion?: string; datasetVersion?: string };
  } | null;
}

export interface ExperienceMemoryRecord {
  id: string;
  type: string;
  key?: string;
  content: string;
  verified: boolean;
  confidence: number;
  status: string;
  source: string;
  sourceArtifact?: string | null;
  verificationEvidence?: { sourceTaskId?: string; evaluationRunId?: string; verifiedAt?: number } | null;
}

export interface EvaluationRegressionSummary {
  benchmarkId?: string;
  baselineRunId?: string | null;
  candidateRunId?: string | null;
  passed: boolean;
  regressions: string[];
  passRateDelta: number;
  timeoutDelta: number;
  durationDelta: number;
  baseline?: EvaluationScore;
  candidate?: EvaluationScore;
}

export interface AciAblationArmMetrics {
  arm: string;
  aciProfile?: string;
  totalTrials: number;
  passedTrials: number;
  failedTrials?: number;
  passRateCI: {
    rate: number;
    lower: number;
    upper: number;
    ci95HalfWidth?: number;
  };
  finalTaskSuccessRate?: number;
  pairedPassTokenReduction: number | null;
  pairedPassCount?: number;
  tokensPerCompletedPass: number | null;
  meanTokensOnPassedTrials?: number | null;
  cacheHitRate: number;
  supervisorCost: {
    calls?: number;
    inputTokens?: number;
    outputTokens?: number;
    totalTokens: number;
    durationMs?: number;
    tokenShareOfTotal?: number;
  };
  tokenBreakdown?: {
    totalTokens?: number;
    meanTokens?: number;
  };
  supersededEvictions?: number;
  supersededTokensSaved?: number;
  partialRecoveries?: number;
  recoveryTokensSaved?: number;
  antiThrashingTriggered?: number;
  decisions?: Partial<AciAdmissionDecisions>;
}

export interface AciAblationSummary {
  available: boolean;
  suite?: string;
  model?: string;
  createdAt?: number | string;
  armOrder?: string[];
  summaryByArm?: Record<string, AciAblationArmMetrics>;
  latexTable?: string;
  markdownTable?: string;
  sourceFile?: string;
}

export type RewindScope = 'files' | 'code' | 'conversation' | 'both';

export interface SessionSnapshotsResponse {
  items: Array<Record<string, unknown>>;
  turns?: Array<Record<string, unknown>>;
  canRedo?: boolean;
  latestRedoId?: string | null;
}

export interface RewindSessionResult {
  ok: boolean;
  sessionId?: string;
  turnId?: string | null;
  scope: string;
  restoredFiles: string[];
  deletedFiles?: string[];
  removedMessages: number;
  redoId?: string | null;
  durationMs?: number;
}

export interface RewindFileResult {
  ok: boolean;
  sessionId?: string;
  turnId?: string | null;
  path: string;
  action: 'restored' | 'deleted' | string;
  redoId?: string | null;
  durationMs?: number;
}

export interface RedoRewindResult {
  ok: boolean;
  sessionId?: string;
  restoredFiles: string[];
  deletedFiles?: string[];
  removedMessages?: number;
  redoId?: string | null;
  durationMs?: number;
}

export interface GitChangeEntry {
  path: string;
  status: string;
  oldPath?: string;
}

export interface GitChangesResponse {
  available: boolean;
  branch: string | null;
  ahead?: number;
  behind?: number;
  headSha?: string | null;
  clean?: boolean;
  staged: GitChangeEntry[];
  unstaged: GitChangeEntry[];
  untracked: GitChangeEntry[];
  blockedSensitive?: string[];
  workspaceRoot?: string;
}

export interface GitCommitResult {
  ok: boolean;
  commitSha: string;
  shortSha: string;
  branch: string | null;
  subject: string;
  filesCommitted?: number;
  changes?: GitChangesResponse;
}

export interface GitMergeResult {
  ok: boolean;
  merged?: boolean;
  branch?: string | null;
  sourceBranch?: string | null;
  commitSha?: string | null;
  conflicts?: string[];
  changes?: GitChangesResponse;
}

export interface ExternalConfigItem {
  id: string;
  provider: string;
  scope: 'user' | 'workspace' | string;
  kind: 'rule' | 'command' | 'skill' | 'agent' | 'mcp' | string;
  name: string;
  displayPath: string;
  summary?: string;
  bytes?: number;
}

export interface ExternalConfigCounts {
  rules: number;
  commands: number;
  skills: number;
  agents: number;
  mcp: number;
  total: number;
}

export interface ExternalConfigDetectResult {
  promptNeeded: boolean;
  onboardingState?: Record<string, unknown>;
  counts: ExternalConfigCounts;
  providers: string[];
  items: ExternalConfigItem[];
}

export interface WorkspaceCustomizationEntry {
  id?: string;
  name: string;
  command?: string;
  description?: string;
  argumentHint?: string;
  summary?: string;
  scope?: string;
  source?: string;
  path?: string;
  displayPath?: string;
  enabled?: boolean;
  disabled?: boolean;
  trusted?: boolean;
  transport?: string;
}

export interface WorkspaceCustomizations {
  workspaceRoot?: string;
  commands: WorkspaceCustomizationEntry[];
  agents: WorkspaceCustomizationEntry[];
  skills: WorkspaceCustomizationEntry[];
  rules: WorkspaceCustomizationEntry[];
  mcpServers: WorkspaceCustomizationEntry[];
}

export interface ExternalImportResult {
  ok: boolean;
  action: 'import' | 'skip' | string;
  importedCount: number;
  importedItems?: Array<Record<string, unknown>>;
  customizations?: WorkspaceCustomizations;
  promptNeeded: boolean;
}
