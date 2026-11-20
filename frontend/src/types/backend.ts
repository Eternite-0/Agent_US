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
  available: boolean;
  branch: string | null;
  dirty: boolean;
  uncommittedCount?: number;
  branches?: string[];
  ahead?: number;
  behind?: number;
}

export interface Submission {
  projectId: string;
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
}

export interface Task extends Entity {
  input: string;
  status: TaskStatus;
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
  status: 'running' | 'done' | 'failed' | 'interrupted';
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

export type PermissionMode = 'approval' | 'auto-safe' | 'full-access';

export type AppView =
  | { kind: 'home' }
  | { kind: 'thread'; taskId: string; focusWorkerId?: string }
  | { kind: 'tasks' }
  | { kind: 'capabilities' }
  | { kind: 'settings'; section: string };

export type CodexMode = 'Codex' | 'Work' | 'Chat';

export type InspectorTab = 'subagents' | 'diff' | 'artifacts' | 'events';

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
