import { PromptCacheProvider } from './components/PromptCacheStatus';
import { cacheRefreshEvent } from './utils/promptCache';
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ApiError, LiveBackendClient, type AgentBackendClient } from './api/client';
import { SimulatorClient } from './api/simulator';
import {
  CapabilitiesView,
  getBundledPluginIcon,
  INITIAL_PLUGINS,
  INITIAL_SKILLS,
  type LocalCatalogSourceInfo,
  type MarketplacePlugin,
  type MarketplaceSkill,
} from './components/CapabilitiesView';
import { ComposerDialog } from './components/ComposerDialog';
import { CreateProjectModal } from './components/CreateProjectModal';
import { EvaluationView } from './components/EvaluationView';
import { McpStatusPanel } from './components/McpStatusPanel';
import { HomeView } from './components/HomeView';
import { DEFAULT_INSPECTOR_WIDTH, InspectorDrawer } from './components/InspectorDrawer';
import { SearchPalette } from './components/SearchPalette';
import { SettingsView } from './components/SettingsView';
import { Sidebar } from './components/Sidebar';
import { TasksView, type ScheduledTaskItem } from './components/TasksView';
import {
  buildCreateSchedulePayload,
  buildUpdateSchedulePayload,
  hydrateScheduleItem,
} from './utils/schedulePayload';
import type { CommandAvailability, SlashCommand, SwarmSection } from './components/slashCommands';
import { ThreadView } from './components/ThreadView';
import { ToastHost } from './components/ToastHost';
import { TopBar } from './components/TopBar';
import type {
  AppearancePreset,
  Approval,
  AppView,
  GitStatus,
  CodexMode,
  ConnectionSettings,
  EffortLevel,
  EventEnvelope,
  InspectorTab,
  MemoryItem,
  ModelSpec,
  PermissionMode,
  Project,
  ProviderAccount,
  ProviderAccountInput,
  ProviderPresetCatalog,
  ProvidersHealth,
  Task,
  SwarmCommandReceipt,
  ThemeMode,
  ToastItem,
  UsageItem,
  WorkspaceEntryKind,
} from './types/backend';
import { isDirectTurnEnd, type DirectLiveStream, type DirectLiveToolOutput } from './utils/directMessages';
import { isSwarmCommand } from './utils/swarmCommand';
import {
  appendRecentEvent,
  createBundleSelector,
  createLatestRequests,
  createSseRefreshScheduler,
  EMPTY_BUNDLE_CACHE,
  mergeRecentEvents,
  mergeTask,
  mergeTaskBundle,
  mergeTaskList,
  shareSnapshot,
  threadRootFor,
  type BundleCache,
} from './utils/sseRefresh';
import { randomIdempotencyKey } from './utils/format';
import { BUILTIN_PROVIDER_PRESETS, mergeProviderPresetCatalog } from './data/providerPresets';

function parseHash(): AppView {
  const hash = window.location.hash.replace(/^#/, '');
  const threadMatch = hash.match(/^\/t\/([^/?]+)/);
  if (threadMatch) return { kind: 'thread', taskId: decodeURIComponent(threadMatch[1]) };
  if (hash.startsWith('/tasks')) return { kind: 'tasks' };
  const pluginMatch = hash.match(/^\/capabilities\/plugins\/([a-zA-Z0-9_-]+)$/);
  if (pluginMatch) return { kind: 'capabilities', pluginId: pluginMatch[1] };
  const capabilitySection = hash.match(/^\/capabilities(?:\/(mcp|skills))?$/)?.[1];
  if (hash.startsWith('/capabilities')) return { kind: 'capabilities', section: capabilitySection === 'mcp' || capabilitySection === 'skills' ? capabilitySection : undefined };
  if (hash.startsWith('/evaluations')) return { kind: 'evaluations' };
  const settingsMatch = hash.match(/^\/settings(?:\/([\w-]+))?/);
  if (settingsMatch) return { kind: 'settings', section: settingsMatch[1] || 'general' };
  return { kind: 'home' };
}

function viewToHash(v: AppView): string {
  switch (v.kind) {
    case 'home':
      return '#/';
    case 'thread':
      return `#/t/${encodeURIComponent(v.taskId)}`;
    case 'tasks':
      return '#/tasks';
    case 'capabilities':
      if (v.pluginId) return `#/capabilities/plugins/${encodeURIComponent(v.pluginId)}`;
      return v.section ? `#/capabilities/${v.section}` : '#/capabilities';
    case 'evaluations':
      return '#/evaluations';
    case 'settings':
      return `#/settings/${encodeURIComponent(v.section || 'general')}`;
  }
}

const EMPTY_THREAD_CHAINS: Record<string, string[]> = {};
let nextConnectionId = 0;

export const App: React.FC = () => {
  // Singleton simulator instance so demo state persists across mode toggles
  const simulatorRef = useRef<SimulatorClient | null>(null);
  if (!simulatorRef.current) simulatorRef.current = new SimulatorClient();

  // Connection state (Bearer token lives strictly in memory; default connects live via proxy)
  const [connection, setConnection] = useState<ConnectionSettings>({
    mode: 'live',
    baseUrl: '',
    token: '',
  });
  const [backendHealthy, setBackendHealthy] = useState<boolean | null>(null);
  const [sseState, setSseState] = useState<'connected' | 'reconnecting' | 'error'>('reconnecting');

  const client: AgentBackendClient = useMemo(() => {
    if (connection.mode === 'demo') return simulatorRef.current!;
    return new LiveBackendClient(connection);
  }, [connection]);

  // A connection epoch is distinct even when returning to the singleton demo client.
  const refreshScope = useMemo(() => ({
    id: ++nextConnectionId,
    workspaceRequests: createLatestRequests<void>(),
    gitRequests: createLatestRequests<string>(),
    permissionUpdates: new Set<string>(),
    workspaceChanging: false,
    bundleRequests: createLatestRequests<string>(),
    archiveRequests: new Set<string>(),
    taskWrites: new Map<string, number>(),
    taskClock: 0,
  }), [client]);
  const currentRefreshScope = useRef<typeof refreshScope | null>(null);
  useLayoutEffect(() => {
    currentRefreshScope.current = refreshScope;
    return () => { currentRefreshScope.current = null; };
  }, [refreshScope]);

  // Atomic navigation history stack (prevents index/stack desync on repeated clicks)
  const [nav, setNav] = useState<{ stack: AppView[]; index: number }>(() => ({
    stack: [parseHash()],
    index: 0,
  }));
  const view = nav.stack[nav.index] ?? { kind: 'home' };

  const navigate = useCallback((next: AppView) => {
    setNav((prev) => {
      const cur = prev.stack[prev.index];
      if (JSON.stringify(cur) === JSON.stringify(next)) return prev;
      const sliced = prev.stack.slice(0, prev.index + 1);
      return {
        stack: [...sliced, next],
        index: sliced.length,
      };
    });
    const targetHash = viewToHash(next);
    if (window.location.hash !== targetHash) {
      window.history.replaceState(null, '', targetHash);
    }
  }, []);

  const goBack = useCallback(() => {
    setNav((prev) => {
      if (prev.index <= 0) return prev;
      const nextIdx = prev.index - 1;
      const target = prev.stack[nextIdx];
      if (target) window.history.replaceState(null, '', viewToHash(target));
      return { ...prev, index: nextIdx };
    });
  }, []);

  const goForward = useCallback(() => {
    setNav((prev) => {
      if (prev.index >= prev.stack.length - 1) return prev;
      const nextIdx = prev.index + 1;
      const target = prev.stack[nextIdx];
      if (target) window.history.replaceState(null, '', viewToHash(target));
      return { ...prev, index: nextIdx };
    });
  }, []);

  useEffect(() => {
    const onHash = () => {
      const parsed = parseHash();
      navigate(parsed);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [navigate]);

  // UI Appearance & Shell state
  const [themeMode, setThemeMode] = useState<ThemeMode>('light');
  const [resolvedTheme, setResolvedTheme] = useState<'light' | 'dark'>('light');
  const [preset, setPreset] = useState<AppearancePreset>('codex');
  const [fontSize, setFontSize] = useState<'compact' | 'default' | 'comfortable'>('default');
  const [reducedMotion, setReducedMotion] = useState(false);
  const [codexMode, setCodexMode] = useState<CodexMode>('Codex');
  const [compactWindow, setCompactWindow] = useState(() => window.matchMedia('(max-width: 820px)').matches);
  const [sidebarPreferences, setSidebarPreferences] = useState({ compact: true, wide: false });
  const layout = compactWindow ? 'compact' : 'wide';
  const sidebarCollapsed = sidebarPreferences[layout];
  const toggleSidebar = useCallback(() => {
    setSidebarPreferences(previous => ({ ...previous, [layout]: !previous[layout] }));
  }, [layout]);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 820px)');
    const sync = () => setCompactWindow(media.matches);
    sync();
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, []);
  const [sidebarWidth, setSidebarWidth] = useState(248);
  const [drawerWidth, setDrawerWidth] = useState(DEFAULT_INSPECTOR_WIDTH);
  const [searchOpen, setSearchOpen] = useState(false);
  const [createProjectOpen, setCreateProjectOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [preferredSwarmRun, setPreferredSwarmRun] = useState<{ sessionId: string; runId: string | null; receipt?: SwarmCommandReceipt; client: AgentBackendClient } | null>(null);
  const [swarmSectionRequest, setSwarmSectionRequest] = useState<{ section: SwarmSection }>();
  const [inspectorRequest, setInspectorRequest] = useState(0);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('subagents');
  const [inspectorFile, setInspectorFile] = useState<string | null>(null);
  const [inspectorSubagentId, setInspectorSubagentId] = useState<string | null>(null);
  const [inspectorTaskId, setInspectorTaskId] = useState<string | null>(null);
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  // Sidebar Pin / Archive, Scheduled Tasks, Plugins/Skills & Multi-Turn Thread Chains (in-memory)
  const [pinnedIds, setPinnedIds] = useState<string[]>([]);
  const [archiveBusy, setArchiveBusy] = useState<ReadonlySet<string>>(() => new Set());
  const [archiveRevision, setArchiveRevision] = useState(0);
  const [scheduledTasks, setScheduledTasks] = useState<ScheduledTaskItem[]>([]);
  // The simulator keeps the same tasks across mode toggles; keep their relationships as well.
  const threadChainOwner = connection.mode === 'demo' ? client : refreshScope;
  const [threadChainState, setThreadChainState] = useState<{ owner: typeof threadChainOwner; chains: Record<string, string[]> }>(
    () => ({ owner: threadChainOwner, chains: EMPTY_THREAD_CHAINS }),
  );
  const threadChains = threadChainState.owner === threadChainOwner ? threadChainState.chains : EMPTY_THREAD_CHAINS;
  const [plugins, setPlugins] = useState<MarketplacePlugin[]>(INITIAL_PLUGINS);
  const [remoteSearchPlugins, setRemoteSearchPlugins] = useState<MarketplacePlugin[] | null>(null);
  const [remoteSearching, setRemoteSearching] = useState(false);
  const [catalogSource, setCatalogSource] = useState<LocalCatalogSourceInfo | null>(null);
  const [installedPluginIds, setInstalledPluginIds] = useState<string[]>([]);
  const [pluginTokens, setPluginTokens] = useState<Record<string, string>>({});
  const [skills, setSkills] = useState<MarketplaceSkill[]>(INITIAL_SKILLS);
  const [forkSource, setForkSource] = useState<string | null>(null);
  const [forkPending, setForkPending] = useState(false);
  const [feedbackDraft, setFeedbackDraft] = useState<string | null>(null);
  const sideProject = new URLSearchParams(window.location.search).get('side-project');
  const [homeDraft, setHomeDraft] = useState<{
    id: number;
    text: string;
    mode: 'replace' | 'append';
  } | null>(null);

  // Composer preferences
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(sideProject?.startsWith('project:') ? sideProject.slice(8) : null);
  const [workedOutsideProject, setWorkedOutsideProject] = useState(false);
  const [selectedModel, setSelectedModel] = useState('');
  const [effort, setEffort] = useState<EffortLevel>('xhigh');
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('auto-safe');
  const [workspaceRoot, setWorkspaceRoot] = useState('');
  const [liveStreams, setLiveStreams] = useState<Record<string, DirectLiveStream>>({});
  const [liveToolOutputs, setLiveToolOutputs] = useState<Record<string, DirectLiveToolOutput[]>>({});
  const [gitState, setGitState] = useState<{ key: string; status?: GitStatus; error?: string } | null>(null);
  const activeRootTaskId = view.kind === 'thread' ? threadRootFor(view.taskId, threadChains) : null;
  const gitSessionId = activeRootTaskId ?? (view.kind === 'home' && sideProject?.startsWith('session:') ? sideProject.slice(8) : undefined);
  const gitKey = JSON.stringify([refreshScope.id, gitSessionId, gitSessionId ? null : workspaceRoot]);
  const currentGitKey = useRef(gitKey);
  useLayoutEffect(() => { currentGitKey.current = gitKey; }, [gitKey]);
  const gitStatus = gitState?.key === gitKey ? gitState.status ?? null : null;
  const gitError = gitState?.key === gitKey ? gitState.error : undefined;
  const [permissionPendingIds, setPermissionPendingIds] = useState<ReadonlySet<string>>(() => new Set());

  // Domain Data
  const [projects, setProjects] = useState<Project[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [models, setModels] = useState<ModelSpec[]>([]);
  const [providersHealth, setProvidersHealth] = useState<ProvidersHealth | null>(null);
  const [providerPresets, setProviderPresets] = useState<ProviderPresetCatalog | null>(BUILTIN_PROVIDER_PRESETS);
  const [providerAccounts, setProviderAccounts] = useState<ProviderAccount[]>([]);
  const [providerAccountsLoading, setProviderAccountsLoading] = useState(false);
  const [memory, setMemory] = useState<MemoryItem[]>([]);
  const [usage, setUsage] = useState<UsageItem[]>([]);
  const [recentEvents, setRecentEvents] = useState<EventEnvelope[]>([]);
  const [bundleState, setBundleState] = useState<{ scope: typeof refreshScope; cache: BundleCache }>(
    () => ({ scope: refreshScope, cache: EMPTY_BUNDLE_CACHE }),
  );
  const [submitting, setSubmitting] = useState(false);
  const [decidingApprovalId, setDecidingApprovalId] = useState<string | null>(null);

  const pushToast = useCallback(
    (
      message: string,
      tone: ToastItem['tone'] = 'default',
      action?: { label: string; onClick: () => void },
    ) => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      setToasts((prev) => [
        ...prev.slice(-3),
        {
          id,
          message,
          tone,
          actionLabel: action?.label,
          onAction: action
            ? () => {
                action.onClick();
                setToasts((cur) => cur.filter((t) => t.id !== id));
              }
            : undefined,
        },
      ]);
      window.setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, action ? 4800 : 2800);
    },
    [],
  );

  const handleOpenThreadInspector = useCallback((tab: InspectorTab, filePath?: string, targetTaskId?: string) => {
    setInspectorTab(tab);
    if (filePath) setInspectorFile(filePath);
    if (targetTaskId) setInspectorTaskId(targetTaskId);
    setInspectorOpen(true);
  }, []);

  // Theme & appearance DOM sync
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const compute = () => {
      const dark = themeMode === 'dark' || (themeMode === 'system' && mq.matches);
      setResolvedTheme(dark ? 'dark' : 'light');
      document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    };
    compute();
    mq.addEventListener('change', compute);
    return () => mq.removeEventListener('change', compute);
  }, [themeMode]);

  useEffect(() => {
    document.documentElement.setAttribute('data-appearance-preset', preset);
  }, [preset]);

  useEffect(() => {
    document.documentElement.setAttribute('data-font-size', fontSize);
  }, [fontSize]);

  useEffect(() => {
    document.documentElement.setAttribute('data-reduced-motion', String(reducedMotion));
  }, [reducedMotion]);

  // Global keyboard shortcuts (1:1 with Codex Desktop)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchOpen((v) => !v);
      } else if (mod && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        toggleSidebar();
      } else if (mod && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        navigate({ kind: 'home' });
      } else if (mod && e.key === ',') {
        e.preventDefault();
        navigate({ kind: 'settings', section: 'general' });
      } else if (mod && e.shiftKey && e.key.toLowerCase() === 'l') {
        e.preventDefault();
        setThemeMode((cur) => (cur === 'dark' ? 'light' : 'dark'));
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [navigate, toggleSidebar]);

  const toggleTheme = useCallback(() => {
    setThemeMode(resolvedTheme === 'dark' ? 'light' : 'dark');
  }, [resolvedTheme]);

  const previousRefreshScope = useRef(refreshScope);
  useLayoutEffect(() => {
    if (previousRefreshScope.current === refreshScope) return;
    previousRefreshScope.current = refreshScope;
    // Do not mix snapshots, event cursors, or ephemeral streams from different connections.
    setBackendHealthy(null);
    setSseState('reconnecting');
    setWorkspaceRoot('');
    setGitState(null);
    setPermissionPendingIds(new Set());
    setProjects([]);
    setTasks([]);
    setApprovals([]);
    setModels([]);
    setProvidersHealth(null);
    setMemory([]);
    setUsage([]);
    setScheduledTasks([]);
    setRecentEvents([]);
    setLiveStreams({});
    setLiveToolOutputs({});
    setBundleState({ scope: refreshScope, cache: EMPTY_BUNDLE_CACHE });
    setInspectorTaskId(null);
    setArchiveBusy(new Set());
  }, [refreshScope]);

  // Mark local task writes independently so a racing list snapshot cannot undo them or
  // suppress fresh data for other tasks. This includes archive removals and newly created tasks.
  const writeTask = useCallback((task: Task, mode: 'upsert' | 'update' | 'archive' = 'upsert') => {
    if (currentRefreshScope.current !== refreshScope) return;
    refreshScope.taskWrites.set(task.id, ++refreshScope.taskClock);
    setTasks((previous) => {
      const current = previous.find((entry) => entry.id === task.id);
      if (mode === 'archive') return current ? previous.filter((entry) => entry !== current) : previous;
      if (!current) {
        return mode === 'update' ? previous
          : [task, ...previous].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
      }
      const next = mergeTask(current, task);
      return next === current ? previous : previous.map((entry) => entry === current ? next : entry);
    });
  }, [refreshScope]);

  const workedOutsideProjectRef = useRef(workedOutsideProject);
  useLayoutEffect(() => { workedOutsideProjectRef.current = workedOutsideProject; }, [workedOutsideProject]);

  // Refresh global workspace collections from live backend (or demo engine if explicitly toggled).
  const refreshWorkspace = useCallback(
    async (notifyOnFailure = false) => {
      if (currentRefreshScope.current !== refreshScope) return;
      const request = refreshScope.workspaceRequests.start();
      try {
        const health = await client.health();
        if (currentRefreshScope.current !== refreshScope || !request.isCurrent()) return;
        const taskClock = refreshScope.taskClock;
        const [projList, taskList, apprList, modelList, pHealth, memList, usgList, evList, schedList] =
          await Promise.all([
            client.listProjects(),
            client.listTasks({ archived: false }),
            client.listApprovals(),
            client.listModels(),
            client.providersHealth(),
            client.listMemory(),
            client.listUsage(),
            client.listEvents({ after: 0 }).catch(() => [] as EventEnvelope[]),
            client.listSchedules?.().catch(() => null) ?? Promise.resolve(null),
          ]);
        if (currentRefreshScope.current !== refreshScope || !request.claim()) return;

        setBackendHealthy(health.ok ?? health.status === 'ok');
        if (health.workspaceRoot && !refreshScope.workspaceChanging) setWorkspaceRoot(health.workspaceRoot);
        setProjects((prev) => shareSnapshot(prev, projList));
        const protectedIds = new Set([...refreshScope.taskWrites]
          .filter(([, clock]) => clock > taskClock).map(([id]) => id));
        setTasks((prev) => mergeTaskList(prev, taskList, protectedIds));
        setApprovals((prev) => shareSnapshot(prev, apprList));
        setModels((prev) => shareSnapshot(prev, modelList));
        setProvidersHealth((prev) => shareSnapshot(prev, pHealth));
        setMemory((prev) => shareSnapshot(prev, memList));
        setUsage((prev) => shareSnapshot(prev, usgList));
        if (schedList) {
          const next = schedList.map(hydrateScheduleItem);
          setScheduledTasks((prev) => shareSnapshot(prev, next));
        }
        if (evList.length) setRecentEvents((prev) => mergeRecentEvents(prev, evList));

        const outsideProject = workedOutsideProjectRef.current;
        setSelectedProjectId((cur) => {
          if (cur && projList.some((p) => p.id === cur)) return cur;
          return outsideProject ? null : projList[0]?.id ?? null;
        });
      } catch (err) {
        if (currentRefreshScope.current !== refreshScope || !request.claim()) return;
        setBackendHealthy(false);
        if (notifyOnFailure && connection.mode === 'live') {
          if (err instanceof ApiError && err.status === 401) {
            pushToast('后端鉴权失败 (401)，请在「设置 → 连接」填写 BACKEND_TOKEN', 'danger', {
              label: '去配置',
              onClick: () => navigate({ kind: 'settings', section: 'connection' }),
            });
          } else {
            pushToast('暂未连接到实时后端 (127.0.0.1:8787)', 'warning', {
              label: '切换本地演示',
              onClick: () => setConnection((c) => ({ ...c, mode: 'demo' })),
            });
          }
        }
      }
    },
    [client, connection.mode, navigate, pushToast, refreshScope],
  );

  const handleRefreshGitStatus = useCallback(async () => {
    if (!client.getGitStatus) return;
    const request = refreshScope.gitRequests.start(gitKey);
    const commit = (next: { status?: GitStatus; error?: string }) => {
      if (currentGitKey.current === gitKey && request.claim()) setGitState({ key: gitKey, ...next });
    };
    try {
      commit({ status: await client.getGitStatus(gitSessionId) });
    } catch (error) {
      commit({ error: error instanceof Error ? error.message : '无法读取 Git 状态' });
    }
  }, [client, gitSessionId, gitKey, refreshScope]);

  useEffect(() => {
    void handleRefreshGitStatus();
  }, [handleRefreshGitStatus]);

  const handleCheckoutGitBranch = useCallback(async (branch: string, create = false) => {
    if (!client.checkoutGitBranch) throw new Error('当前连接暂不支持切换 Git 分支');
    if (refreshScope.workspaceChanging || !gitStatus?.available) throw new Error('请等待工作区 Git 状态就绪');
    const request = refreshScope.gitRequests.start(gitKey);
    try {
      const next = await client.checkoutGitBranch(branch, create, gitSessionId, gitStatus.workspaceRoot);
      if (currentGitKey.current === gitKey && request.claim()) setGitState({ key: gitKey, status: next });
      pushToast(create ? `已创建并检出分支 ${next.branch || branch}` : `已切换到分支 ${next.branch || branch}`, 'success');
    } catch (error) {
      if (error instanceof ApiError && error.code === 'WORKSPACE_CHANGED') void handleRefreshGitStatus();
      throw error;
    }
  }, [client, gitSessionId, gitKey, gitStatus, refreshScope, pushToast, handleRefreshGitStatus]);

  const handleInitGitRepo = useCallback(async () => {
    if (!client.initGitRepo || !gitStatus || gitStatus.available || refreshScope.workspaceChanging) return;
    const request = refreshScope.gitRequests.start(gitKey);
    try {
      const next = await client.initGitRepo('main', gitSessionId, gitStatus.workspaceRoot);
      if (currentGitKey.current === gitKey && request.claim()) setGitState({ key: gitKey, status: next });
      pushToast(`Git 存储库已就绪${next.branch ? `（当前分支：${next.branch}）` : ''}`, 'success');
    } catch (error) {
      if (error instanceof ApiError && error.code === 'WORKSPACE_CHANGED') void handleRefreshGitStatus();
      pushToast(error instanceof Error ? error.message : '创建 Git 存储库失败', 'danger');
    }
  }, [client, gitSessionId, gitKey, gitStatus, refreshScope, pushToast, handleRefreshGitStatus]);

  const refreshProviderAccounts = useCallback(async () => {
    if (connection.mode === 'demo' || !client.providerPresets || !client.listAccounts) {
      setProviderPresets(BUILTIN_PROVIDER_PRESETS);
      setProviderAccounts([]);
      return;
    }
    setProviderAccountsLoading(true);
    try {
      const [presetCatalog, accountList] = await Promise.all([
        client.providerPresets(),
        client.listAccounts(),
      ]);
      setProviderPresets(mergeProviderPresetCatalog(presetCatalog));
      setProviderAccounts(accountList);
    } catch (error) {
      if (connection.mode === 'live') {
        pushToast(error instanceof ApiError ? `账号管理接口不可用：${error.code}` : '读取供应商账号失败', 'warning');
      }
    } finally {
      setProviderAccountsLoading(false);
    }
  }, [client, connection.mode, pushToast]);

  useEffect(() => {
    if (backendHealthy !== false) void refreshProviderAccounts();
  }, [refreshProviderAccounts, backendHealthy]);

  const createProviderAccount = useCallback(async (input: ProviderAccountInput, opts?: { autoSync?: boolean }) => {
    if (!client.createAccount) throw new Error('当前数据源不支持供应商账号管理。');
    const account = await client.createAccount(input);
    setProviderAccounts((current) => [...current, account].sort((a, b) => a.priority - b.priority));
    if (opts?.autoSync && client.syncAccountModels) {
      try {
        const synced = await client.syncAccountModels(account.id);
        setProviderAccounts((current) => current.map((item) => (item.id === account.id ? synced.account : item)));
        await refreshWorkspace(true);
        pushToast(`已添加账号并同步 ${synced.models.length} 个模型，已热接入后端对话！`, 'success');
        return;
      } catch (syncErr) {
        await refreshWorkspace(true);
        pushToast(
          `账号已添加，但自动拉取模型失败：${syncErr instanceof Error ? syncErr.message : '请手动测试'}`,
          'warning',
        );
        return;
      }
    }
    await refreshWorkspace(true);
    pushToast(`已添加供应商账号：${account.label || account.id}`, 'success');
  }, [client, pushToast, refreshWorkspace]);

  const batchProviderAccounts = useCallback(async (ids: string[], action: 'enable' | 'disable' | 'delete' | 'clear-cooldown') => {
    if (!client.batchAccounts) return;
    const res = await client.batchAccounts(ids, action);
    await refreshProviderAccounts();
    await refreshWorkspace(false);
    pushToast(`批量操作完成（影响 ${res.count} 个账号）`, 'success');
  }, [client, pushToast, refreshProviderAccounts, refreshWorkspace]);

  const reorderProviderGroups = useCallback(async (order: string[]) => {
    if (!client.setProviderPriorities) return;
    await client.setProviderPriorities(order);
    await refreshProviderAccounts();
    pushToast('已更新号池顺位优先级', 'success');
  }, [client, pushToast, refreshProviderAccounts]);

  const queryAccountBalance = useCallback(async (id: string) => {
    if (!client.queryAccountBalance) return;
    const res = await client.queryAccountBalance(id);
    setProviderAccounts((current) => current.map((item) => (item.id === id ? res.account : item)));
    pushToast(`余额查询：${res.balance.display}`, res.balance.supported ? 'success' : 'default');
  }, [client, pushToast]);

  const queryAllBalances = useCallback(async () => {
    if (!client.queryAllBalances) return;
    await client.queryAllBalances();
    await refreshProviderAccounts();
    pushToast('已刷新全部启用账号余额', 'success');
  }, [client, pushToast, refreshProviderAccounts]);

  const handleChangeWorkspaceRoot = useCallback(async (dirPath: string) => {
    if (!client.setWorkspace) throw new Error('当前连接不支持切换工作区');
    if (refreshScope.workspaceChanging) throw new Error('正在切换工作区，请稍后重试');
    refreshScope.workspaceChanging = true;
    try {
      const res = await client.setWorkspace(dirPath);
      if (currentRefreshScope.current !== refreshScope) return;
      refreshScope.workspaceRequests.invalidate(undefined);
      setWorkspaceRoot(res.workspaceRoot);
      pushToast(`新会话工作区：${res.workspaceRoot}。已有会话保留原目录。`, 'success');
    } finally {
      refreshScope.workspaceChanging = false;
      if (currentRefreshScope.current === refreshScope) void refreshWorkspace(false);
    }
  }, [client, pushToast, refreshScope, refreshWorkspace]);

  const updateProviderAccount = useCallback(async (id: string, patch: Partial<ProviderAccountInput>) => {
    if (!client.updateAccount) throw new Error('当前数据源不支持供应商账号管理。');
    const account = await client.updateAccount(id, patch);
    setProviderAccounts((current) => current.map((item) => item.id === id ? account : item).sort((a, b) => a.priority - b.priority));
    await refreshWorkspace(true);
    pushToast(`已更新供应商账号：${account.label || account.id}`, 'success');
  }, [client, pushToast, refreshWorkspace]);

  const deleteProviderAccount = useCallback(async (id: string) => {
    if (!client.deleteAccount) throw new Error('当前数据源不支持供应商账号管理。');
    await client.deleteAccount(id);
    setProviderAccounts((current) => current.filter((item) => item.id !== id));
    await refreshWorkspace(true);
    pushToast('已删除供应商账号', 'success');
  }, [client, pushToast, refreshWorkspace]);

  const testProviderAccount = useCallback(async (id: string) => {
    if (!client.testAccount) throw new Error('当前数据源不支持供应商账号管理。');
    const result = await client.testAccount(id);
    setProviderAccounts((current) => current.map((item) => item.id === id ? result : item));
    await refreshWorkspace(true);
    pushToast(result.ok ? `连接成功 · ${result.latencyMs}ms` : '连接失败，账号已进入冷却', result.ok ? 'success' : 'warning');
  }, [client, pushToast, refreshWorkspace]);

  const syncProviderAccount = useCallback(async (id: string) => {
    if (!client.syncAccountModels) throw new Error('当前数据源不支持供应商账号管理。');
    const result = await client.syncAccountModels(id);
    setProviderAccounts((current) => current.map((item) => item.id === id ? result.account : item));
    await refreshWorkspace(true);
    pushToast(`已同步 ${result.models.length} 个模型`, 'success');
  }, [client, pushToast, refreshWorkspace]);

  const importLocalProviderAccounts = useCallback(async () => {
    if (!client.importLocalAccounts) throw new Error('当前数据源不支持供应商账号管理。');
    const result = await client.importLocalAccounts();
    setProviderAccounts((current) => [...current, ...result.items]);
    await refreshWorkspace(true);
    pushToast(result.items.length ? `已导入 ${result.items.length} 个本地账号` : '未发现可导入的本地账号', result.items.length ? 'success' : 'default');
  }, [client, pushToast, refreshWorkspace]);

  // Probe and bootstrap each connection. Only the latest probe can report an error.
  useEffect(() => {
    void refreshWorkspace(true);
  }, [refreshWorkspace]);

  // Load standalone Agent_US extension catalog (built-in seed + public GitHub / MCP hub, ZERO ~/.codex dependency)
  const loadExtensionCatalog = useCallback(async (syncUpstream = false) => {
    try {
      const res = await fetch(
        syncUpstream ? '/api/extensions/catalog?refresh=1' : '/api/extensions/catalog',
      );
      if (!res.ok) return;
      const data = (await res.json()) as {
        source?: LocalCatalogSourceInfo;
        plugins?: MarketplacePlugin[];
        skills?: MarketplaceSkill[];
        installedPluginIds?: string[];
      };
      if (data.source) setCatalogSource(data.source);
      if (Array.isArray(data.plugins) && data.plugins.length > 0) {
        setPlugins(data.plugins);
      }
      if (Array.isArray(data.skills) && data.skills.length > 0) {
        setSkills(data.skills);
      }
      if (Array.isArray(data.installedPluginIds)) {
        setInstalledPluginIds(data.installedPluginIds);
      }
    } catch {
      // Built-in frontend seed remains active when running without server bridge
    }
  }, []);

  useEffect(() => {
    void loadExtensionCatalog(false);
  }, [loadExtensionCatalog]);

  const handleSearchRemotePlugins = useCallback(async (query: string) => {
    if (!query) {
      setRemoteSearchPlugins(null);
      setRemoteSearching(false);
      return;
    }
    setRemoteSearching(true);
    try {
      const res = await fetch(`/api/extensions/catalog?q=${encodeURIComponent(query)}`);
      if (!res.ok) {
        setRemoteSearchPlugins(null);
        return;
      }
      const data = (await res.json()) as { plugins?: MarketplacePlugin[] };
      if (Array.isArray(data.plugins)) {
        setRemoteSearchPlugins(data.plugins);
      }
    } catch {
      setRemoteSearchPlugins(null);
    } finally {
      setRemoteSearching(false);
    }
  }, []);

  // Resolve the true chain before rendering so navigating to a child keeps the same thread instance.
  const activeChainIds = useMemo(() => {
    if (!activeRootTaskId) return [];
    const children = Object.hasOwn(threadChains, activeRootTaskId) ? threadChains[activeRootTaskId] : [];
    return [...new Set([activeRootTaskId, ...children])];
  }, [activeRootTaskId, threadChains]);
  const activeChainRef = useRef(activeChainIds);
  useLayoutEffect(() => { activeChainRef.current = activeChainIds; }, [activeChainIds]);

  const bundleCache = bundleState.scope === refreshScope ? bundleState.cache : EMPTY_BUNDLE_CACHE;
  const selectActiveBundles = useMemo(() => createBundleSelector(), [refreshScope]);
  const activeBundles = selectActiveBundles(bundleCache, activeChainIds);
  const bundleLoading = activeChainIds.some((id) => !bundleCache.has(id));

  const refreshActiveBundles = useCallback(
    async (taskIds: readonly string[]) => {
      if (currentRefreshScope.current !== refreshScope) return;
      await Promise.all([...new Set(taskIds)].map(async (id) => {
        const request = refreshScope.bundleRequests.start(id);
        const loaded = await client.loadTaskBundle(id).catch(() => null);
        if (currentRefreshScope.current !== refreshScope || !request.claim()) return;
        setBundleState((previous) => {
          if (previous.scope !== refreshScope) return previous;
          const cache = mergeTaskBundle(previous.cache, id, loaded);
          return cache === previous.cache ? previous : { scope: refreshScope, cache };
        });
      }));
    },
    [client, refreshScope],
  );

  const sessionTask = activeBundles.find(({ task }) => task.id === activeRootTaskId)?.task
    ?? tasks.find(({ id }) => id === activeRootTaskId);
  const sessionPermission = sessionTask?.permissionMode ?? permissionMode;
  const permissionPending = activeRootTaskId !== null && (permissionPendingIds.has(activeRootTaskId) || !sessionTask);
  const changeThreadPermission = async (mode: PermissionMode) => {
    const id = activeRootTaskId;
    if (!id || sessionPermission === 'read-only' || permissionPending || refreshScope.permissionUpdates.has(id)) return;
    if (!client.updateSessionPermission) { setPermissionMode(mode); return; }
    refreshScope.permissionUpdates.add(id);
    setPermissionPendingIds(new Set(refreshScope.permissionUpdates));
    try {
      const saved = await client.updateSessionPermission(id, mode);
      if (currentRefreshScope.current !== refreshScope) return;
      refreshScope.taskWrites.set(id, ++refreshScope.taskClock);
      refreshScope.bundleRequests.invalidate(id);
      setTasks((prev) => prev.map((task) => task.id === id ? { ...task, permissionMode: saved } : task));
      setBundleState((prev) => {
        const bundle = prev.cache.get(id);
        if (prev.scope !== refreshScope || !bundle) return prev;
        const cache = new Map(prev.cache);
        cache.set(id, { ...bundle, task: { ...bundle.task, permissionMode: saved } });
        return { scope: refreshScope, cache };
      });
    } catch (error) {
      if (currentRefreshScope.current === refreshScope) pushToast(`权限未更改：${error instanceof Error ? error.message : '更新失败'}`, 'danger');
    } finally {
      refreshScope.permissionUpdates.delete(id);
      if (currentRefreshScope.current === refreshScope) setPermissionPendingIds(new Set(refreshScope.permissionUpdates));
    }
  };

  const handleStartReview = async (baseBranch?: string) => {
    if (!client.startGitReview || !gitStatus?.available || refreshScope.workspaceChanging) throw new Error('请等待工作区 Git 状态就绪');
    setSubmitting(true);
    try {
      const task = await client.startGitReview({ sessionId: gitSessionId, expectedWorkspaceRoot: gitStatus.workspaceRoot, baseBranch, model: selectedModel || undefined, effort });
      if (currentRefreshScope.current !== refreshScope) return;
      writeTask(task);
      if (currentGitKey.current === gitKey) navigate({ kind: 'thread', taskId: task.id });
    } catch (error) {
      if (error instanceof ApiError && error.code === 'WORKSPACE_CHANGED') void handleRefreshGitStatus();
      throw error;
    } finally {
      setSubmitting(false);
    }
  };

  // Switching engines leaves task IDs from the previous engine behind. Reconfiguring a live
  // endpoint keeps the URL but loads it against a clean connection-scoped cache.
  const prevConnModeRef = useRef(connection.mode);
  const switchingEngine = prevConnModeRef.current !== connection.mode;
  useEffect(() => {
    if (switchingEngine) {
      prevConnModeRef.current = connection.mode;
      if (view.kind === 'thread') navigate({ kind: 'home' });
    }
  }, [switchingEngine, connection.mode, navigate, view.kind]);

  useEffect(() => {
    if (switchingEngine || !activeChainIds.length) {
      setInspectorTaskId(null);
      return;
    }
    void refreshActiveBundles(activeChainIds);
  }, [switchingEngine, activeChainIds, refreshActiveBundles]);

  // Only persisted/structural events invalidate REST data. Ephemeral deltas update their
  // task-local stream immediately, without triggering a workspace or bundle fetch.
  useEffect(() => {
    let disposed = false;
    const isCurrent = () => !disposed && currentRefreshScope.current === refreshScope;
    const scheduler = createSseRefreshScheduler(
      () => isCurrent() ? activeChainRef.current : [],
      () => refreshWorkspace(false),
      (id) => refreshActiveBundles([id]),
    );

    const unsubscribe = client.subscribeEvents(
      {},
      (ev) => {
        if (!isCurrent()) return;
        const sid = ev.taskId || (typeof ev.payload?.sessionId === 'string' ? ev.payload.sessionId : '');
        const turnId = typeof ev.payload?.turnId === 'string' ? ev.payload.turnId : undefined;
        const callId = typeof ev.payload?.callId === 'string' ? ev.payload.callId : '';
        if (ev.type === 'tool/output') {
          if (!sid) return;
          const chunk = String(ev.payload?.chunk ?? '');
          const name = String(ev.payload?.name ?? 'bash');
          if (callId && chunk) {
            setLiveToolOutputs((prev) => {
              const outputs = prev[sid] ?? [];
              const cur = outputs.find((entry) => entry.callId === callId && entry.turnId === turnId);
              const output = { turnId, callId, name, text: ((cur?.text ?? '') + chunk).slice(-12000) };
              return { ...prev, [sid]: [...outputs.filter((entry) => entry !== cur), output] };
            });
          }
          return;
        }
        if (ev.type === 'assistant/delta' || ev.type === 'reasoning/delta') {
          if (!sid) return;
          setLiveStreams((prev) => {
            const stream = prev[sid];
            const cur = stream && stream.turnId === turnId ? stream : { text: '', reasoning: '' };
            const key = ev.type === 'assistant/delta' ? 'text' : 'reasoning';
            const next = String(ev.payload?.text ?? (cur[key] + String(ev.payload?.delta ?? '')));
            if (stream && stream.turnId === turnId && stream[key] === next) return prev;
            return { ...prev, [sid]: { ...cur, turnId, [key]: next } };
          });
          return;
        }
        const turnEnded = isDirectTurnEnd(ev.type);
        if (sid && (ev.type === 'tool/result' || turnEnded || ev.type === 'turn/started')) {
          setLiveToolOutputs((prev) => {
            if (!prev[sid]) return prev;
            const outputs = prev[sid].filter((entry) =>
              ev.type === 'turn/started' ? entry.turnId === turnId
                : (turnId && entry.turnId !== turnId) || (!turnEnded && entry.callId !== callId),
            );
            if (outputs.length === prev[sid].length) return prev;
            const next = { ...prev };
            if (outputs.length) next[sid] = outputs;
            else delete next[sid];
            return next;
          });
        }
        // A reasoning-only model step can transition directly to tools without assistant/message.
        if (sid && (turnEnded || ev.type === 'assistant/message' || ev.type === 'tool/call' || ev.type === 'turn/started')) {
          setLiveStreams((prev) => {
            const stream = prev[sid];
            if (!stream || (ev.type === 'turn/started' ? turnId === stream.turnId : turnId && turnId !== stream.turnId)) return prev;
            const next = { ...prev };
            delete next[sid];
            return next;
          });
        }
        if (ev.type === 'reconciliation/required') {
          pushToast('检测到待人工核对的外部操作 (outcome_unknown)', 'warning');
        } else if (ev.type === 'session/recovered') {
          pushToast('已从检查点恢复中断会话', 'success');
        }
        setRecentEvents((prev) => appendRecentEvent(prev, ev));
        scheduler.event(ev);
      },
      (state) => {
        if (!isCurrent()) return;
        setSseState(state);
        scheduler.status(state);
      },
    );

    return () => {
      disposed = true;
      scheduler.stop();
      unsubscribe();
    };
  }, [client, refreshScope, refreshWorkspace, refreshActiveBundles, pushToast]);

  // Domain Actions
  const handleSelectProject = useCallback((projectId: string | null) => {
    setSelectedProjectId(projectId);
    setWorkedOutsideProject(projectId === null);
  }, []);

  const handleCreateProject = async (name: string, sourceFolders: string[] = []) => {
    if (sourceFolders.length > 0 && client.setWorkspace) await handleChangeWorkspaceRoot(sourceFolders[0]);
    const project = await client.createProject(name);
    setProjects((prev) => [...prev, project]);
    setSelectedProjectId(project.id);
    setWorkedOutsideProject(false);
    pushToast(`已创建项目 ${project.name}`, 'success');
  };

  const handleRenameProject = async (project: Project, newName: string) => {
    try {
      const updated = await client.renameProject(project.id, newName, project.version);
      setProjects((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
      pushToast(`项目已重命名为 ${updated.name}`);
    } catch (e) {
      pushToast(`重命名失败：${e instanceof Error ? e.message : '版本冲突'}`, 'danger');
    }
  };

  const showSwarmReceipt = (receipt: SwarmCommandReceipt & { id: string }) => {
    setPreferredSwarmRun({ client, sessionId: receipt.id, runId: receipt.runId, receipt });
    setInspectorTaskId(receipt.id);
    setSwarmSectionRequest({ section: 'plan' });
    setInspectorRequest((value) => value + 1);
    setInspectorTab('autonomous');
    setInspectorOpen(true);
  };

  const handleSubmitNewTask = async (text: string, files: Record<string, string>): Promise<boolean> => {
    if (refreshScope.workspaceChanging) { pushToast('请等待工作区切换完成', 'warning'); return false; }
    setSubmitting(true);
    try {
      const sideSource = sideProject?.startsWith('session:') ? await client.getTask(sideProject.slice(8)) : null;
      let projectId = sideSource?.projectId ?? selectedProjectId;
      if (!projectId) {
        const created = await client.createProject('Agent_US Workspace');
        setProjects((prev) => [...prev, created]);
        projectId = created.id;
        setSelectedProjectId(created.id);
      }

      const task = await client.submitTask({
        effort,
        projectId,
        input: text,
        idempotencyKey: randomIdempotencyKey(),
        ...(selectedModel ? { model: selectedModel } : {}),
        permissionMode,
        workspaceRoot: sideSource?.workspaceRoot || workspaceRoot || undefined,
        ...(Object.keys(files).length ? { files } : {}),
      });

      if (currentRefreshScope.current !== refreshScope) return false;
      if ('mode' in task) {
        showSwarmReceipt(task);
        void refreshWorkspace(false);
      } else {
        writeTask(task);
      }
      navigate({ kind: 'thread', taskId: task.id });
      return true;
    } catch (e) {
      pushToast(`提交任务失败：${e instanceof Error ? e.message : '未知错误'}`, 'danger');
      return false;
    } finally {
      setSubmitting(false);
    }
  };

  // Multi-turn follow-up inside an existing ThreadView: appends Turn N+1 to the same conversation!
  const handleSubmitFollowup = async (text: string, files: Record<string, string>): Promise<boolean> => {
    if (!activeRootTaskId) {
      return handleSubmitNewTask(text, files);
    }
    if (refreshScope.permissionUpdates.has(activeRootTaskId)) {
      pushToast('请等待会话权限更新完成', 'warning');
      return false;
    }
    setSubmitting(true);
    try {
      const currentRoot = tasks.find((t) => t.id === activeRootTaskId) ?? activeBundles[0]?.task;
      if (currentRoot?.status === 'running' && client.steerSession && !isSwarmCommand(text) && !text.startsWith('/plan ') && Object.keys(files).length === 0) {
        const steered = await client.steerSession(activeRootTaskId, text);
        if (steered.steered) {
          pushToast('已实时注入纠偏指令，Agent 将在下一步生效', 'success');
          return true;
        }
      }
      if (client.submitFollowupTurn) {
        const updated = await client.submitFollowupTurn(activeRootTaskId, text, {
          model: selectedModel || undefined,
          // The backend already holds this session's live policy; don't overwrite it
          // with preferences from Home, another thread, or an older snapshot.
          ...(!client.updateSessionPermission ? { permissionMode } : {}),
          ...(Object.keys(files).length ? { files } : {}),
          effort,
          clientTurnId: randomIdempotencyKey(),
        });
        if (currentRefreshScope.current !== refreshScope || activeChainRef.current[0] !== activeRootTaskId) return false;
        if ('mode' in updated) showSwarmReceipt(updated);
        else writeTask(updated, 'update');
        await refreshActiveBundles([activeRootTaskId]);
        return true;
      }
      const rootTask = tasks.find((t) => t.id === activeRootTaskId) ?? activeBundles[0]?.task;
      let projectId = rootTask?.projectId ?? selectedProjectId;
      if (!projectId) {
        const created = await client.createProject('Agent_US Workspace');
        setProjects((prev) => [...prev, created]);
        projectId = created.id;
        setSelectedProjectId(created.id);
      }

      const nextTask = await client.submitTask({
        effort,
        projectId,
        input: text,
        idempotencyKey: randomIdempotencyKey(),
        ...(selectedModel ? { model: selectedModel } : {}),
        permissionMode,
        ...(workspaceRoot ? { workspaceRoot } : {}),
        ...(Object.keys(files).length ? { files } : {}),
      });

      if (currentRefreshScope.current !== refreshScope) return false;
      if ('mode' in nextTask) {
        showSwarmReceipt(nextTask);
        navigate({ kind: 'thread', taskId: nextTask.id });
        void refreshWorkspace(false);
        return true;
      }
      writeTask(nextTask);
      setThreadChainState((prev) => {
        const chains = prev.owner === threadChainOwner ? prev.chains : EMPTY_THREAD_CHAINS;
        const children = chains[activeRootTaskId] ?? [];
        if (nextTask.id === activeRootTaskId || children.includes(nextTask.id)) return prev;
        return { owner: threadChainOwner, chains: { ...chains, [activeRootTaskId]: [...children, nextTask.id] } };
      });
      setInspectorTaskId(nextTask.id);
      return true;
    } catch (e) {
      pushToast(`发送追问失败：${e instanceof Error ? e.message : '未知错误'}`, 'danger');
      return false;
    } finally {
      setSubmitting(false);
    }
  };

  const handleControlTask = async (
    task: Task,
    action: 'pause' | 'resume' | 'cancel' | 'retry',
  ) => {
    try {
      const updated = await client.controlTask(task.id, action, task.version);
      if (currentRefreshScope.current !== refreshScope) return;
      writeTask(updated, 'update');
      if (activeChainRef.current.includes(updated.id)) {
        void refreshActiveBundles([updated.id]);
      }
      const label = {
        pause: '已暂停任务',
        resume: '已恢复任务',
        cancel: '已取消任务',
        retry: '已重新调度任务',
      }[action];
      pushToast(label);
    } catch (e) {
      pushToast(`操作失败：${e instanceof Error ? e.message : '状态冲突'}`, 'danger');
    }
  };

  const handleDecideApproval = async (
    approval: Approval,
    decision: 'approve' | 'deny',
    scope?: 'once' | 'session',
    outcome?: 'happened' | 'not_applied' | 'abort',
  ) => {
    setDecidingApprovalId(approval.id);
    try {
      if (approval.kind === 'reconciliation' && outcome && client.resolveReconciliation) {
        await client.resolveReconciliation(approval.id, outcome);
        pushToast(
          outcome === 'happened'
            ? `已确认 ${approval.tool} 已执行，继续恢复任务`
            : outcome === 'not_applied'
              ? `已确认 ${approval.tool} 未产生副作用`
              : `已中止 ${approval.tool} 相关任务`,
          outcome === 'abort' ? 'warning' : 'success',
        );
      } else {
        await client.decideApproval(approval.id, approval.version, decision, scope);
        pushToast(
          decision === 'approve'
            ? scope === 'session'
              ? `已本会话自动放行 ${approval.tool}`
              : `已批准 ${approval.tool}`
            : `已拒绝 ${approval.tool}`,
          decision === 'approve' ? 'success' : 'warning',
        );
      }
      await refreshWorkspace(false);
      if (activeChainRef.current.length) {
        await refreshActiveBundles(activeChainRef.current);
      }
    } catch (e) {
      pushToast(`审批裁决失败：${e instanceof Error ? e.message : '审批已失效'}`, 'danger');
    } finally {
      setDecidingApprovalId(null);
    }
  };

  const handleRewindSession = useCallback(
    async (sessionId: string, scope: 'code' | 'conversation' | 'both' = 'code', turnId?: string) => {
      if (!client.rewindSession) {
        pushToast('当前数据源暂不支持会话快照回退', 'warning');
        return;
      }
      try {
        const res = await client.rewindSession(sessionId, { scope, turnId });
        await refreshWorkspace(false);
        await refreshActiveBundles([sessionId]);
        pushToast(
          res.restoredFiles.length
            ? `已回退 ${res.restoredFiles.length} 个文件${res.removedMessages ? `并撤销 ${res.removedMessages} 条消息` : ''}`
            : res.removedMessages
              ? `已回退会话（撤销 ${res.removedMessages} 条消息）`
              : '未发现需要回退的文件变更',
          'success',
        );
      } catch (e) {
        pushToast(`回退失败：${e instanceof Error ? e.message : '暂无可用快照'}`, 'warning');
      }
    },
    [client, pushToast, refreshWorkspace, refreshActiveBundles],
  );

  const handleCompactSession = useCallback(
    async (sessionId: string) => {
      if (!client.compactSession) {
        pushToast('当前数据源暂不支持上下文压缩', 'warning');
        return;
      }
      try {
        const res = await client.compactSession(sessionId);
        await refreshActiveBundles([sessionId]);
        pushToast(
          res.compacted
            ? `已完成语义上下文压缩（折叠 ${res.compressedCount ?? 0} 条历史消息）`
            : res.reason || '当前上下文仍很精简，无需压缩',
          res.compacted ? 'success' : 'default',
        );
      } catch (e) {
        pushToast(`上下文压缩失败：${e instanceof Error ? e.message : '未知错误'}`, 'danger');
      }
    },
    [client, pushToast, refreshActiveBundles],
  );

  const handleTogglePin = (taskId: string) => {
    const exists = pinnedIds.includes(taskId);
    setPinnedIds((prev) =>
      exists ? prev.filter((id) => id !== taskId) : [taskId, ...prev.filter((id) => id !== taskId)],
    );
    pushToast(exists ? '已取消置顶' : '已置顶到顶部');
  };

  const updateArchive = async (taskId: string, archived: boolean): Promise<boolean> => {
    if (currentRefreshScope.current !== refreshScope || refreshScope.archiveRequests.has(taskId)) return false;
    refreshScope.archiveRequests.add(taskId);
    setArchiveBusy(new Set(refreshScope.archiveRequests));
    try {
      const updated = await client.setTaskArchived(taskId, archived);
      if (currentRefreshScope.current !== refreshScope) return false;
      writeTask(updated, archived ? 'archive' : 'upsert');
      // Invalidate only this task's older snapshot, not the rest of the active chain.
      refreshScope.bundleRequests.invalidate(taskId);
      setBundleState((prev) => {
        if (prev.scope !== refreshScope) return prev;
        const bundle = prev.cache.get(taskId);
        if (!bundle) return prev;
        const cache = mergeTaskBundle(prev.cache, taskId, {
          ...bundle, task: { ...bundle.task, archivedAt: updated.archivedAt },
        });
        return cache === prev.cache ? prev : { scope: refreshScope, cache };
      });
      if (activeChainRef.current.includes(taskId)) void refreshActiveBundles([taskId]);
      setArchiveRevision((prev) => prev + 1);
      return true;
    } catch (error) {
      if (currentRefreshScope.current === refreshScope) {
        pushToast(`${archived ? '归档' : '恢复'}失败：${error instanceof Error ? error.message : '连接异常'}`, 'danger');
      }
      return false;
    } finally {
      refreshScope.archiveRequests.delete(taskId);
      if (currentRefreshScope.current === refreshScope) setArchiveBusy(new Set(refreshScope.archiveRequests));
    }
  };

  const handleRestoreArchived = async (taskId: string) => {
    if (await updateArchive(taskId, false)) pushToast('已恢复聊天', 'success');
  };

  const handleArchiveTask = async (taskId: string) => {
    if (await updateArchive(taskId, true)) {
      pushToast('已归档聊天', 'success', { label: '撤销', onClick: () => void handleRestoreArchived(taskId) });
    }
  };

  const handleSubmitGoal = async (goal: string, files: Record<string, string>): Promise<boolean> => {
    if (activeRootTaskId && (sessionPermission === 'read-only' || refreshScope.permissionUpdates.has(activeRootTaskId))) {
      pushToast(sessionPermission === 'read-only' ? '请在普通会话中启动自主任务' : '请等待会话权限更新完成', 'warning');
      return false;
    }
    if (!client.submitAutonomousGoal) {
      pushToast('当前连接不支持自主任务。', 'warning');
      return false;
    }
    if (Object.keys(files).length) {
      pushToast('自主任务支持 @工作区文件。请移除上传附件后重试。', 'warning');
      return false;
    }
    setSubmitting(true);
    try {
      const result = await client.submitAutonomousGoal({
        goal,
        ...(activeRootTaskId ? { sessionId: activeRootTaskId } : { workspaceRoot: workspaceRoot || undefined, permissionMode }),
      });
      if (currentRefreshScope.current !== refreshScope) return true;
      navigate({ kind: 'thread', taskId: result.sessionId });
      setInspectorTaskId(result.sessionId);
      setPreferredSwarmRun({ ...result, client });
      setSwarmSectionRequest({ section: 'plan' });
      setInspectorRequest((value) => value + 1);
      setInspectorTab('autonomous');
      setInspectorOpen(true);
      if (activeRootTaskId === result.sessionId) void refreshActiveBundles(activeChainRef.current);
      void refreshWorkspace(false);
      pushToast('自主任务已启动', 'success');
      return true;
    } catch (error) {
      if (currentRefreshScope.current === refreshScope) pushToast(`自主任务启动失败：${error instanceof Error ? error.message : '连接异常'}`, 'danger');
      return false;
    } finally {
      setSubmitting(false);
    }
  };

  const searchMentionFiles = useMemo(() => {
    if (!client.searchWorkspaceFiles) return undefined;
    return (query: string, signal: AbortSignal, kind: WorkspaceEntryKind) => client.searchWorkspaceFiles!(query, gitSessionId, signal, kind);
  }, [client, gitSessionId, workspaceRoot]);

  const slashTask = activeBundles.find(({ task }) => task.id === activeRootTaskId)?.task
    ?? tasks.find(({ id }) => id === activeRootTaskId);
  const archiveBlock = !slashTask ? '会话尚未加载' : archiveBusy.has(slashTask.id) ? '正在更新归档状态' : undefined;
  const sessionSwarm = preferredSwarmRun?.client === client && preferredSwarmRun.sessionId === activeRootTaskId ? preferredSwarmRun : null;
  const swarmEventSeq = recentEvents.findLast((event) =>
    activeRootTaskId && event.type.startsWith('swarm/') &&
    (event.taskId === activeRootTaskId || event.payload?.sessionId === activeRootTaskId),
  )?.seq ?? 0;
  const swarmBlock = !client.listSwarmRuns ? '当前连接未提供自主任务' : undefined;
  const commandAvailability: CommandAvailability = {
    '/goal': !client.submitAutonomousGoal ? '当前连接未提供自主任务' : undefined,
    '/swarm': client.isDemo ? '演示连接不支持 Swarm 命令' : undefined,
    '/swarm-plan': swarmBlock,
    '/messages': swarmBlock ?? (!client.listSwarmMessages ? '当前连接未提供协作消息' : undefined),
    '/artifacts': swarmBlock ?? (!client.listSwarmArtifacts ? '当前连接未提供自主任务产物' : undefined),
    '/fork': !client.forkTask ? '当前连接未提供聊天分支' : slashTask?.status === 'running' ? '请等待当前聊天执行结束' : undefined,
    '/side': sideProject !== null ? '请从主窗口开启侧边聊天' : undefined,
    '/compact': !client.compactSession ? '当前连接未提供上下文压缩' : undefined,
    '/rewind': !client.rewindSession ? '当前连接未提供会话回退' : undefined,
    '/archive-chat': archiveBlock ?? (slashTask?.archivedAt != null ? '此会话已归档' : undefined),
    '/restore': archiveBlock ?? (slashTask?.archivedAt == null ? '此会话尚未归档' : undefined),
  };

  const handleSlashCommand = ({ cmd, view: target, inspector, swarmSection }: SlashCommand) => {
    if (target) {
      navigate(target.kind === 'capabilities' && target.section === 'mcp' && activeRootTaskId
        ? { ...target, sessionId: activeRootTaskId }
        : target);
      return;
    }
    if (inspector) {
      if (swarmSection) setSwarmSectionRequest({ section: swarmSection });
      setInspectorTab(inspector);
      setInspectorTaskId(activeRootTaskId);
      setInspectorFile(null);
      setInspectorSubagentId(null);
      setInspectorOpen(true);
      setInspectorRequest((value) => value + 1);
      return;
    }
    switch (cmd) {
      case '/search':
        setSearchOpen(true);
        break;
      case '/new-project':
        setCreateProjectOpen(true);
        break;
      case '/side': {
        const target = new URL(window.location.href);
        target.hash = '';
        target.search = '';
        const context = activeRootTaskId ? `session:${activeRootTaskId}` : `project:${selectedProjectId ?? ''}`;
        target.searchParams.set('side-project', context);
        window.open(target, '_blank', 'popup,noopener,width=700,height=750');
        break;
      }
      case '/fork':
        if (activeRootTaskId) setForkSource(activeRootTaskId);
        break;
      case '/feedback':
        setFeedbackDraft('');
        break;
      case '/plan':
        if (codexMode === 'Work') {
          setCodexMode('Codex');
          pushToast('已退出计划模式');
        } else {
          setCodexMode('Work');
          if (activeRootTaskId) void changeThreadPermission('approval');
          else setPermissionMode('approval');
          pushToast('已开启计划模式');
        }
        break;
      case '/run':
        setCodexMode('Codex');
        pushToast('已切换为执行模式');
        break;
      case '/chat':
        setCodexMode('Chat');
        pushToast('已切换为对话模式');
        break;
      case '/theme':
        toggleTheme();
        break;
      case '/compact':
        if (activeRootTaskId) void handleCompactSession(activeRootTaskId);
        break;
      case '/rewind':
        if (activeRootTaskId && window.confirm('回退上一轮的对话和工作区文件变更？')) {
          void handleRewindSession(activeRootTaskId, 'both');
        }
        break;
      case '/pin':
        if (activeRootTaskId) handleTogglePin(activeRootTaskId);
        break;
      case '/archive-chat':
        if (activeRootTaskId) void handleArchiveTask(activeRootTaskId);
        break;
      case '/restore':
        if (activeRootTaskId) void handleRestoreArchived(activeRootTaskId);
        break;
      case '/copy-link':
        void (async () => {
          try {
            await navigator.clipboard.writeText(window.location.href);
            pushToast('已复制当前聊天链接', 'success');
          } catch {
            pushToast('未能访问剪贴板', 'warning');
          }
        })();
        break;
    }
  };

  const createChatFork = async (workspaceMode: 'same-workspace' | 'new-worktree') => {
    if (!forkSource || !client.forkTask || forkPending) return;
    setForkPending(true);
    try {
      const task = await client.forkTask(forkSource, workspaceMode);
      if (currentRefreshScope.current !== refreshScope) return;
      writeTask(task);
      setForkSource(null);
      navigate({ kind: 'thread', taskId: task.id });
      pushToast('已创建聊天分支', 'success');
    } catch (error) {
      pushToast(`创建聊天分支失败：${error instanceof Error ? error.message : '未知错误'}`, 'danger');
    } finally {
      setForkPending(false);
    }
  };

  const exportFeedback = () => {
    if (!feedbackDraft?.trim()) return;
    const blob = new Blob([`# Agent_US 聊天反馈\n\n${feedbackDraft.trim()}\n`], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'agent-us-feedback.md';
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setFeedbackDraft(null);
  };

  const handleSearchMemory = useCallback(async (query: string, scope: 'global' | 'workspace' | 'session') => {
    try {
      setMemory(await client.listMemory({ q: query.trim() || undefined, scope, limit: 200 }));
    } catch (error) {
      pushToast(`记忆检索失败：${error instanceof Error ? error.message : '未知错误'}`, 'warning');
    }
  }, [client, pushToast]);

  const handleDeleteMemory = useCallback(async (item: MemoryItem) => {
    if (!client.deleteMemory || !item.key) return;
    try {
      await client.deleteMemory(item.key, { scope: item.scope?.type ?? 'global', sessionId: item.scope?.type === 'session' ? item.scope.id : undefined });
      setMemory((current) => current.filter((entry) => entry.id !== item.id));
      pushToast('记忆已删除', 'success');
    } catch (error) {
      pushToast(`删除记忆失败：${error instanceof Error ? error.message : '未知错误'}`, 'danger');
    }
  }, [client, pushToast]);

  const handleFetchVersion = useCallback(
    async (taskId: string, version: number): Promise<Task | null> => {
      try {
        return await client.getTaskVersion(taskId, version);
      } catch (e) {
        pushToast(`读取版本 v${version} 失败：${e instanceof Error ? e.message : '未知错误'}`, 'danger');
        return null;
      }
    },
    [client, pushToast],
  );

  // Exclude child follow-up tasks from sidebar top-level list so multi-turn threads stay grouped
  const childTurnSet = useMemo(() => {
    const s = new Set<string>();
    for (const ids of Object.values(threadChains)) {
      for (const id of ids) s.add(id);
    }
    return s;
  }, [threadChains]);

  const sidebarTasks = useMemo(
    () => tasks.filter((t) => !childTurnSet.has(t.id)),
    [tasks, childTurnSet],
  );

  const archivedThread = view.kind === 'thread'
    ? activeBundles.find((bundle) => bundle.task.id === activeRootTaskId && bundle.task.archivedAt != null)
    : undefined;

  // Known files across active bundles & tasks for Ctrl+K file search and @ mentions
  const knownFiles = useMemo(() => {
    const map = new Map<string, { path: string; taskId: string }>();
    for (const b of activeBundles) {
      for (const ev of b.evidence) {
        if (ev.path) map.set(`${b.task.id}:${ev.path}`, { path: ev.path, taskId: b.task.id });
        for (const ch of ev.changes ?? []) {
          map.set(`${b.task.id}:${ch.path}`, { path: ch.path, taskId: b.task.id });
        }
      }
      for (const art of b.artifacts) {
        for (const p of Object.keys(art.files ?? {})) {
          map.set(`${b.task.id}:${p}`, { path: p, taskId: b.task.id });
        }
      }
    }
    for (const t of tasks) {
      for (const p of Object.keys(t.files ?? {})) {
        map.set(`${t.id}:${p}`, { path: p, taskId: t.id });
      }
    }
    return [...map.values()];
  }, [activeBundles, tasks]);

  const mentionFiles = useMemo(
    () => Array.from(new Set(knownFiles.map((f) => f.path))),
    [knownFiles],
  );

  const mentionPlugins = useMemo(
    () =>
      plugins
        .filter((plugin) => installedPluginIds.includes(plugin.id) || plugin.id.startsWith('office-'))
        .map((plugin) => ({
          id: plugin.id,
          name: plugin.name,
          description: plugin.description,
          iconUrl: getBundledPluginIcon(plugin, resolvedTheme),
          color: plugin.id.startsWith('office-') ? plugin.brandColor : undefined,
          installed: installedPluginIds.includes(plugin.id),
        })),
    [plugins, installedPluginIds, resolvedTheme],
  );

  const mentionSkills = useMemo(
    () => skills.filter((s) => s.installed).map(({ id, name, description }) => ({ id, name, description })),
    [skills],
  );

  const selectedProject = workedOutsideProject
    ? null
    : projects.find((p) => p.id === selectedProjectId) ?? projects[0] ?? null;

  const pendingApprovals = useMemo(
    () => approvals.filter((a) => a.status === 'pending'),
    [approvals],
  );

  const inspectorBundle = useMemo(() => {
    if (!activeBundles.length) return null;
    if (inspectorTaskId) {
      const found = activeBundles.find((b) => b.task.id === inspectorTaskId);
      if (found) return found;
    }
    return activeBundles[activeBundles.length - 1] ?? null;
  }, [activeBundles, inspectorTaskId]);

  const activeWorkers = useMemo(
    () => activeBundles.flatMap((b) => b.workers),
    [activeBundles],
  );

  const routerReady = Boolean(providersHealth?.routerReady || models.length > 0);

  const connectionTone =
    connection.mode === 'demo'
      ? 'demo'
      : backendHealthy && sseState === 'connected'
        ? 'live'
        : backendHealthy
          ? 'warn'
          : 'danger';

  const connectionLabel =
    connection.mode === 'demo'
      ? '本地演示'
      : backendHealthy
        ? sseState === 'connected'
          ? '已连接 Backend'
          : 'SSE 重连中'
        : '未连接后端';

  const lastCacheEvent = recentEvents.findLast(event => cacheRefreshEvent(event.type));
  const cacheRevision = lastCacheEvent ? `${lastCacheEvent.seq}:${lastCacheEvent.type}` : '';
  return (
    <PromptCacheProvider client={client} revision={cacheRevision}>
    <div className="codex-shell">
      <TopBar
        canBack={nav.index > 0}
        canForward={nav.index < nav.stack.length - 1}
        sidebarCollapsed={sidebarCollapsed}
        connectionLabel={connectionLabel}
        connectionTone={connectionTone}
        theme={resolvedTheme}
        onBack={goBack}
        onForward={goForward}
        onToggleSidebar={toggleSidebar}
        onNewChat={() => navigate({ kind: 'home' })}
        onNewProject={() => setCreateProjectOpen(true)}
        onOpenSettings={(sec) => navigate({ kind: 'settings', section: sec || 'general' })}
        onOpenSearch={() => setSearchOpen(true)}
        onToggleTheme={toggleTheme}
        onToggleInspector={() => setInspectorOpen((v) => !v)}
        onRefresh={() => {
          void refreshWorkspace(false);
          if (activeChainRef.current.length) {
            void refreshActiveBundles(activeChainRef.current);
          }
          pushToast('已刷新数据');
        }}
      />

      <div
        className="codex-body"
        data-settings-view={view.kind === 'settings' ? 'true' : undefined}
        data-capabilities-view={view.kind === 'capabilities' ? 'true' : undefined}
      >
        <Sidebar
          view={view}
          collapsed={sidebarCollapsed}
          hidePanel={
            view.kind === 'settings' || view.kind === 'tasks' || view.kind === 'capabilities' || view.kind === 'evaluations'
          }
          width={sidebarWidth}
          codexMode={codexMode}
          projects={projects}
          tasks={sidebarTasks}
          pinnedIds={pinnedIds}
          archiveBusy={archiveBusy}
          selectedProjectId={selectedProject?.id ?? null}
          activeWorkers={activeWorkers}
          pendingApprovals={pendingApprovals}
          onResize={setSidebarWidth}
          onChangeCodexMode={(m) => {
            setCodexMode(m);
            pushToast(`已切换工作模式：${m}`);
          }}
          onSelectHome={(projId) => {
            if (projId) setSelectedProjectId(projId);
            navigate({ kind: 'home' });
          }}
          onSelectTask={(taskId, focusWorkerId) => {
            const t = tasks.find((x) => x.id === taskId);
            if (t?.projectId) setSelectedProjectId(t.projectId);
            navigate({ kind: 'thread', taskId });
            if (focusWorkerId) {
              setInspectorTaskId(taskId);
              setInspectorSubagentId(focusWorkerId);
              setInspectorTab('subagents');
              setInspectorOpen(true);
            }
          }}
          onSelectTasksView={() => navigate({ kind: 'tasks' })}
          onSelectCapabilities={() => navigate({ kind: 'capabilities' })}
          onSelectEvaluations={() => navigate({ kind: 'evaluations' })}
          onOpenSettings={(sec) => navigate({ kind: 'settings', section: sec || 'general' })}
          onOpenSearch={() => setSearchOpen(true)}
          onOpenCreateProject={() => setCreateProjectOpen(true)}
          onRenameProject={handleRenameProject}
          onTogglePin={handleTogglePin}
          onArchiveTask={handleArchiveTask}
          onDecideApproval={handleDecideApproval}
          onToast={(msg) => pushToast(msg)}
        />

        <main
          className="codex-main-surface"
          data-frameless={
            view.kind === 'settings' || view.kind === 'tasks' || view.kind === 'capabilities' || view.kind === 'evaluations'
              ? 'true'
              : undefined
          }
        >
          <div className="codex-workspace-column">
            {view.kind === 'home' && (
              <HomeView
                codexMode={codexMode}
                projects={projects}
                selectedProject={selectedProject}
                models={models}
                selectedModel={selectedModel}
                effort={effort}
                permissionMode={permissionMode}
                gitStatus={gitStatus}
                gitError={gitError}
                mentionPlugins={mentionPlugins}
                mentionSkills={mentionSkills}
                draftInjection={homeDraft}
                submitting={submitting}
                inspectorOpen={inspectorOpen}
                routerReady={routerReady}
                isLiveBackend={connection.mode === 'live' && backendHealthy === true}
                onSelectProject={handleSelectProject}
                onOpenCreateProject={() => setCreateProjectOpen(true)}
                onSelectModel={setSelectedModel}
                onChangeEffort={setEffort}
                onChangePermission={setPermissionMode}
                onRefreshGitStatus={handleRefreshGitStatus}
                onCheckoutGitBranch={handleCheckoutGitBranch}
                onInitGitRepo={client.initGitRepo ? handleInitGitRepo : undefined}
                onStartReview={client.startGitReview ? handleStartReview : undefined}
                onSlashCommand={handleSlashCommand}
                commandAvailability={commandAvailability}
                searchMentionFiles={searchMentionFiles}
                onSubmitGoal={handleSubmitGoal}
                onSubmitTask={handleSubmitNewTask}
                onToggleInspector={() => setInspectorOpen((v) => !v)}
                onOpenSettings={(sec) => navigate({ kind: 'settings', section: sec || 'general' })}
              />
            )}

            {archivedThread && (
              <div className="chat-archive-notice">
                <span>此聊天已归档</span>
                <button type="button" className="chat-archive-link" disabled={archiveBusy.has(archivedThread.task.id)}
                  onClick={() => void handleRestoreArchived(archivedThread.task.id)}>
                  {archiveBusy.has(archivedThread.task.id) ? '正在恢复…' : '恢复到列表'}
                </button>
              </div>
            )}
            {view.kind === 'thread' && (
              <ThreadView
                key={`${refreshScope.id}:${activeRootTaskId}`}
                onOpenSwarmRun={(sessionId, runId) => {
                  setPreferredSwarmRun({ client, sessionId, runId });
                  setInspectorTaskId(sessionId);
                  setSwarmSectionRequest({ section: 'plan' });
                  setInspectorRequest((value) => value + 1);
                  setInspectorTab('autonomous');
                  setInspectorOpen(true);
                }}
                bundles={activeBundles}
                loading={bundleLoading}
                focusWorkerId={view.focusWorkerId}
                liveStreams={liveStreams}
                liveToolOutputs={liveToolOutputs}
                onRewindSession={handleRewindSession}
                onCompactSession={handleCompactSession}
                codexMode={codexMode}
                projects={projects}
                selectedProject={selectedProject}
                models={models}
                selectedModel={selectedModel}
                effort={effort}
                permissionMode={sessionPermission}
                permissionPending={permissionPending}
                gitStatus={gitStatus}
                gitError={gitError}
                mentionFiles={mentionFiles}
                mentionPlugins={mentionPlugins}
                mentionSkills={mentionSkills}
                submitting={submitting}
                inspectorOpen={inspectorOpen}
                inspectorTab={inspectorTab}
                decidingApprovalId={decidingApprovalId}
                routerReady={routerReady}
                isLiveBackend={connection.mode === 'live' && backendHealthy === true}
                onSelectProject={handleSelectProject}
                onOpenCreateProject={() => setCreateProjectOpen(true)}
                onSelectModel={setSelectedModel}
                onChangeEffort={setEffort}
                onChangePermission={changeThreadPermission}
                onRefreshGitStatus={handleRefreshGitStatus}
                onCheckoutGitBranch={handleCheckoutGitBranch}
                onInitGitRepo={client.initGitRepo ? handleInitGitRepo : undefined}
                onStartReview={client.startGitReview ? handleStartReview : undefined}
                onSlashCommand={handleSlashCommand}
                commandAvailability={commandAvailability}
                searchMentionFiles={searchMentionFiles}
                onSubmitGoal={handleSubmitGoal}
                onSubmitFollowup={handleSubmitFollowup}
                onControlTask={handleControlTask}
                archiving={activeRootTaskId !== null && archiveBusy.has(activeRootTaskId)}
                onToggleArchive={(task) => void (task.archivedAt != null
                  ? handleRestoreArchived(task.id)
                  : handleArchiveTask(task.id))}
                onDecideApproval={handleDecideApproval}
                onOpenInspector={handleOpenThreadInspector}
                onOpenSubagent={(workerId, targetTaskId) => {
                  if (targetTaskId) setInspectorTaskId(targetTaskId);
                  setInspectorSubagentId(workerId);
                  setInspectorTab('subagents');
                  setInspectorRequest((value) => value + 1);
                  setInspectorOpen(true);
                }}
                onToggleInspector={() => setInspectorOpen((v) => !v)}
                onClearFocusWorker={() => navigate({ kind: 'thread', taskId: view.taskId })}
                onFocusWorker={(wId) =>
                  navigate({ kind: 'thread', taskId: view.taskId, focusWorkerId: wId })
                }
                onOpenSettings={(sec) => navigate({ kind: 'settings', section: sec || 'general' })}
                onSwitchToDemo={() => {
                  setConnection((c) => ({ ...c, mode: 'demo' }));
                  navigate({ kind: 'home' });
                  pushToast('已切换至本地演示引擎，可体验完整多步执行流与审批', 'default');
                }}
                onToast={pushToast}
              />
            )}

            {view.kind === 'tasks' && (
              <TasksView
                scheduledTasks={scheduledTasks}
                tasks={tasks}
                projects={projects}
                selectedProjectId={selectedProject?.id ?? null}
                onCreateScheduled={async (item) => {
                  if (client.createSchedule) {
                    const payload = buildCreateSchedulePayload(item, {
                      workspaceRoot: workspaceRoot || undefined,
                      model: selectedModel || undefined,
                      permissionMode,
                    });
                    try {
                      const saved = await client.createSchedule(payload);
                      const hydrated = {
                        ...hydrateScheduleItem(saved),
                        projectId: item.projectId,
                      };
                      setScheduledTasks((prev) => [hydrated, ...prev]);
                      pushToast(`已保存定时任务「${hydrated.title}」`, 'success');
                    } catch (e) {
                      const msg = e instanceof Error ? e.message : '请求失败';
                      pushToast(`创建定时任务失败：${msg}`, 'danger');
                      throw e;
                    }
                    return;
                  }
                  const created: ScheduledTaskItem = {
                    ...item,
                    id: `sched-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                    nextRunAt: null,
                    lastRunAt: null,
                    lastStatus: null,
                    lastRunTaskIds: [],
                    createdAt: Date.now(),
                  };
                  setScheduledTasks((prev) => [created, ...prev]);
                  pushToast(`已创建定时任务「${created.title}」`, 'success');
                }}
                onUpdateScheduled={async (id, patch) => {
                  const current = scheduledTasks.find((s) => s.id === id) ?? null;
                  if (client.updateSchedule) {
                    const payload = buildUpdateSchedulePayload(patch, current);
                    try {
                      const saved = await client.updateSchedule(id, payload);
                      const hydrated = {
                        ...hydrateScheduleItem(saved),
                        projectId: patch.projectId !== undefined ? patch.projectId : (current?.projectId ?? null),
                      };
                      setScheduledTasks((prev) =>
                        prev.map((s) => (s.id === id ? hydrated : s)),
                      );
                      if (patch.paused !== undefined) {
                        pushToast(patch.paused ? '已暂停定时任务' : '已恢复定时任务');
                      } else {
                        pushToast(`已更新定时任务「${hydrated.title}」`, 'success');
                      }
                    } catch (e) {
                      const msg = e instanceof Error ? e.message : '更新失败';
                      pushToast(`更新定时任务失败：${msg}`, 'danger');
                      throw e;
                    }
                    return;
                  }
                  setScheduledTasks((prev) =>
                    prev.map((s) => (s.id === id ? { ...s, ...patch } : s)),
                  );
                  if (patch.paused !== undefined) {
                    pushToast(patch.paused ? '已暂停定时任务' : '已恢复定时任务');
                  }
                }}
                onDeleteScheduled={async (id) => {
                  if (client.deleteSchedule) {
                    try {
                      await client.deleteSchedule(id);
                    } catch (e) {
                      const msg = e instanceof Error ? e.message : '删除失败';
                      pushToast(`删除定时任务失败：${msg}`, 'danger');
                      throw e;
                    }
                  }
                  setScheduledTasks((prev) => prev.filter((s) => s.id !== id));
                  pushToast('已删除定时任务');
                }}
                onRunScheduledNow={async (item) => {
                  if (client.runScheduleNow) {
                    try {
                      const out = await client.runScheduleNow(item.id);
                      await refreshWorkspace(false);
                      pushToast(`已触发定时任务「${item.title}」`, 'success');
                      navigate({ kind: 'thread', taskId: out.session.id });
                    } catch (e) {
                      const msg = e instanceof Error ? e.message : '触发失败';
                      pushToast(`触发定时任务失败：${msg}`, 'danger');
                    }
                    return;
                  }
                  let projectId = item.projectId ?? selectedProject?.id ?? null;
                  if (!projectId) {
                    const created = await client.createProject('Agent_US Workspace');
                    setProjects((prev) => [...prev, created]);
                    projectId = created.id;
                    setSelectedProjectId(created.id);
                  }
                  const task = await client.submitTask({
                    effort,
                    projectId,
                    input: item.prompt,
                    idempotencyKey: randomIdempotencyKey(),
                    ...(selectedModel ? { model: selectedModel } : {}),
                    permissionMode,
                    ...(workspaceRoot ? { workspaceRoot } : {}),
                  });
                  if (currentRefreshScope.current !== refreshScope) return;
                  if ('mode' in task) showSwarmReceipt(task);
                  else writeTask(task);
                  setScheduledTasks((prev) =>
                    prev.map((s) =>
                      s.id === item.id
                        ? { ...s, lastRunTaskIds: [task.id, ...s.lastRunTaskIds] }
                        : s,
                    ),
                  );
                  pushToast(`已触发定时任务「${item.title}」`, 'success');
                  navigate({ kind: 'thread', taskId: task.id });
                }}
                onSelectTask={(taskId) => navigate({ kind: 'thread', taskId })}
              />
            )}

            {view.kind === 'evaluations' && (
              <EvaluationView client={client} models={models} onToast={pushToast} />
            )}
            {view.kind === 'capabilities' && view.section === 'mcp' && (
              <McpStatusPanel client={client} sessionId={view.sessionId} onManagePlugins={() => navigate({ kind: 'capabilities' })} />
            )}
            {view.kind === 'capabilities' && view.section !== 'mcp' && (
              <CapabilitiesView
                key={view.section ?? 'plugins'}
                initialTab={view.section === 'skills' ? 'skills' : 'plugins'}
                initialPluginId={view.pluginId}
                theme={resolvedTheme}
                catalogSource={catalogSource}
                plugins={plugins}
                remoteSearchResults={remoteSearchPlugins}
                remoteSearching={remoteSearching}
                installedPluginIds={installedPluginIds}
                pluginTokens={pluginTokens}
                skills={skills}
                onSearchRemotePlugins={(q) => void handleSearchRemotePlugins(q)}
                onRefreshCatalog={(sync) => loadExtensionCatalog(Boolean(sync))}
                onToggleInstallPlugin={async (plugin) => {
                  const installed = installedPluginIds.includes(plugin.id);
                  try {
                    const response = await fetch(`/api/extensions/plugins/${installed ? 'uninstall' : 'install'}`, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify(installed ? { id: plugin.id } : { plugin }),
                    });
                    if (!response.ok) throw new Error(`HTTP ${response.status}`);
                    const result = await response.json() as { installedPluginIds: string[]; fetchedFromGithub?: boolean };
                    setInstalledPluginIds(result.installedPluginIds);
                    if (!installed) setPlugins((prev) => prev.some((p) => p.id === plugin.id) ? prev : [plugin, ...prev]);
                    pushToast(`${installed ? '已卸载' : '已安装'}插件 ${plugin.name}`, 'success');
                  } catch (error) {
                    pushToast(`插件操作失败：${error instanceof Error ? error.message : '未知错误'}`, 'danger');
                  }
                }}
                onSavePluginConfig={async (plugin, endpoint, token) => {
                  setPlugins((prev) =>
                    prev.map((p) => (p.id === plugin.id && endpoint ? { ...p, endpoint } : p)),
                  );
                  setPluginTokens((prev) => ({ ...prev, [plugin.id]: token }));
                  if (installedPluginIds.includes(plugin.id)) {
                    try {
                      await fetch('/api/extensions/plugins/install', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ plugin: { ...plugin, endpoint }, endpoint }),
                      });
                    } catch {
                      // ignore
                    }
                    pushToast(`已保存 ${plugin.name} 配置`, 'success');
                  }
                }}
                onAddCustomPlugin={async (plugin) => {
                  setPlugins((prev) => [plugin, ...prev]);
                  setInstalledPluginIds((prev) => [plugin.id, ...prev]);
                  try {
                    await fetch('/api/extensions/plugins/install', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ plugin }),
                    });
                  } catch {
                    // ignore
                  }
                  pushToast(`已添加并安装插件 ${plugin.name}`, 'success');
                }}
                onInstallGithubPlugin={async (repoUrl, category) => {
                  try {
                    const res = await fetch('/api/extensions/plugins/install-github', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ url: repoUrl, category }),
                    });
                    const data = (await res.json()) as {
                      ok?: boolean;
                      error?: string;
                      plugin?: MarketplacePlugin;
                      fetchedFromGithub?: boolean;
                      installedPluginIds?: string[];
                    };
                    if (!res.ok || !data.plugin) {
                      pushToast(data.error || 'GitHub 插件安装失败', 'danger');
                      return;
                    }
                    setPlugins((prev) => [
                      data.plugin!,
                      ...prev.filter((p) => p.id !== data.plugin!.id),
                    ]);
                    if (Array.isArray(data.installedPluginIds)) {
                      setInstalledPluginIds(data.installedPluginIds);
                    }
                    pushToast(
                      data.fetchedFromGithub
                        ? `已从 GitHub 拉取并安装 ${data.plugin.name}`
                        : `已安装 ${data.plugin.name}（离线元数据模式）`,
                      'success',
                    );
                  } catch {
                    pushToast('连接本地扩展服务失败', 'danger');
                  }
                }}
                onToggleInstallSkill={async (skillId) => {
                  const target = skills.find((s) => s.id === skillId);
                  const nextState = target ? !target.installed : true;
                  setSkills((prev) =>
                    prev.map((s) => (s.id === skillId ? { ...s, installed: nextState } : s)),
                  );
                  let fromGh = false;
                  try {
                    const res = await fetch('/api/extensions/skills/toggle', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ id: skillId, installed: nextState, skill: target }),
                    });
                    if (res.ok) {
                      const info = (await res.json()) as { fetchedFromGithub?: boolean };
                      fromGh = Boolean(info.fetchedFromGithub);
                    }
                  } catch {
                    // ignore
                  }
                  if (target) {
                    pushToast(
                      nextState
                        ? `已启用技能 ${target.name}${fromGh ? '（已从 GitHub 下载 SKILL.md）' : ''}`
                        : `已停用技能 ${target.name}`,
                      nextState ? 'success' : 'default',
                    );
                  }
                }}
                onUpdateSkill={async (skillId, patch) => {
                  const target = skills.find((s) => s.id === skillId);
                  setSkills((prev) =>
                    prev.map((s) => (s.id === skillId ? { ...s, ...patch } : s)),
                  );
                  if (target) {
                    try {
                      await fetch('/api/extensions/skills/save', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ skill: { ...target, ...patch } }),
                      });
                    } catch {
                      // ignore
                    }
                  }
                  pushToast('已保存技能指令 (SKILL.md)', 'success');
                }}
                onAddCustomSkill={async (skill) => {
                  setSkills((prev) => [skill, ...prev]);
                  try {
                    await fetch('/api/extensions/skills/save', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ skill }),
                    });
                  } catch {
                    // ignore
                  }
                  pushToast(`已创建并保存技能 ${skill.name}`, 'success');
                }}
                onDeleteCustomSkill={async (skillId) => {
                  const target = skills.find((s) => s.id === skillId);
                  setSkills((prev) => prev.filter((s) => s.id !== skillId));
                  try {
                    await fetch('/api/extensions/skills/delete', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ id: skillId, slug: target?.slug }),
                    });
                  } catch {
                    // ignore
                  }
                  pushToast('已删除自定义技能');
                }}
                onTryPrompt={(prompt) => {
                  setHomeDraft({ id: Date.now(), text: prompt, mode: 'replace' });
                  navigate({ kind: 'home' });
                }}
                onOpenSettings={(sec) => navigate({ kind: 'settings', section: sec || 'general' })}
                onToast={(msg, tone) => pushToast(msg, tone)}
              />
            )}

            {view.kind === 'settings' && (
              <SettingsView
                section={view.section}
                client={client}
                workspaceRoot={workspaceRoot}
                onBatchProviderAccounts={batchProviderAccounts}
                onReorderProviderGroups={reorderProviderGroups}
                onQueryAccountBalance={queryAccountBalance}
                onQueryAllBalances={queryAllBalances}
                onModelsChanged={() => refreshWorkspace(false)}
                onChangeWorkspaceRoot={client.setWorkspace ? handleChangeWorkspaceRoot : undefined}
                onToast={pushToast}
                themeMode={themeMode}
                preset={preset}
                fontSize={fontSize}
                reducedMotion={reducedMotion}
                permissionMode={permissionMode}
                connection={connection}
                backendHealthy={backendHealthy}
                models={models}
                providersHealth={providersHealth}
                providerPresets={providerPresets}
                providerAccounts={providerAccounts}
                providerAccountsLoading={providerAccountsLoading}
                onRefreshProviderAccounts={refreshProviderAccounts}
                onCreateProviderAccount={createProviderAccount}
                onUpdateProviderAccount={updateProviderAccount}
                onDeleteProviderAccount={deleteProviderAccount}
                onTestProviderAccount={testProviderAccount}
                onSyncProviderAccount={syncProviderAccount}
                onImportLocalProviderAccounts={importLocalProviderAccounts}
                approvals={approvals}
                memory={memory}
                usage={usage}
                archiveClient={client}
                archiveBusy={archiveBusy}
                archiveRevision={archiveRevision}
                recentEvents={recentEvents}
                onChangeSection={(sec) => navigate({ kind: 'settings', section: sec })}
                onChangeThemeMode={setThemeMode}
                onChangePreset={(next) => {
                  setPreset(next);
                  pushToast(`已应用外观预设：${next}`);
                }}
                onChangeFontSize={setFontSize}
                onChangeReducedMotion={setReducedMotion}
                onChangePermissionMode={setPermissionMode}
                onUpdateConnection={(next) => {
                  setConnection((previous) => (
                    previous.mode === next.mode && previous.baseUrl === next.baseUrl && previous.token === next.token
                      ? previous : next
                  ));
                  pushToast(
                    next.mode === 'demo' ? '已切换至本地演示引擎' : '已保存实时后端连接配置',
                  );
                }}
                onTestConnection={async (next) => {
                  if (next && next.mode === 'live') {
                    const probeClient = new LiveBackendClient(next);
                    const health = await probeClient.health();
                    if (health.ok === false) throw new Error('后端健康检查未通过');
                    await probeClient.listModels();
                    await probeClient.providersHealth();
                    if (
                      next.baseUrl.trim() !== connection.baseUrl.trim() ||
                      next.token.trim() !== connection.token.trim() ||
                      connection.mode !== 'live'
                    ) {
                      pushToast('连接参数已更新，正在使用新端点刷新工作区', 'success');
                      return;
                    }
                  }
                  await refreshWorkspace(true);
                }}
                onDecideApproval={handleDecideApproval}
                onRestoreArchived={handleRestoreArchived}
                onOpenTask={(taskId) => navigate({ kind: 'thread', taskId })}
                onSearchMemory={handleSearchMemory}
                onDeleteMemory={handleDeleteMemory}
              />
            )}
          </div>

          <InspectorDrawer
            open={inspectorOpen && (view.kind === 'thread' || view.kind === 'home')}
            width={drawerWidth}
            tab={inspectorTab}
            tabRequest={inspectorRequest}
            swarmSectionRequest={swarmSectionRequest}
            selectedFile={inspectorFile}
            selectedSubagentId={inspectorSubagentId}
            projectName={selectedProject?.name || 'Agent_US'}
            bundle={inspectorBundle}
            client={client}
            sessionId={activeRootTaskId}
            preferredRunId={sessionSwarm?.runId ?? undefined}
            swarmReceipt={sessionSwarm?.receipt}
            swarmEventSeq={swarmEventSeq}
            swarmApprovals={approvals}
            onResize={setDrawerWidth}
            onChangeTab={setInspectorTab}
            onSelectFile={setInspectorFile}
            onSelectSubagent={setInspectorSubagentId}
            onFetchVersion={handleFetchVersion}
            onClose={() => setInspectorOpen(false)}
            onToast={(msg) => pushToast(msg)}
          />
        </main>
      </div>

      <SearchPalette
        open={searchOpen}
        projects={projects}
        tasks={sidebarTasks}
        historyClient={client}
        historyRevision={archiveRevision}
        knownFiles={knownFiles}
        onClose={() => setSearchOpen(false)}
        onSelectTask={(taskId) => navigate({ kind: 'thread', taskId })}
        onSelectFile={(taskId, path) => {
          navigate({ kind: 'thread', taskId });
          setInspectorTaskId(taskId);
          setInspectorFile(path);
          setInspectorTab('diff');
          setInspectorOpen(true);
        }}
        onSelectProject={(projectId) => {
          setSelectedProjectId(projectId);
          navigate({ kind: 'home' });
        }}
        onNewChat={() => navigate({ kind: 'home' })}
        onToggleTheme={toggleTheme}
        onOpenSettings={(sec) => navigate({ kind: 'settings', section: sec || 'general' })}
      />

      <CreateProjectModal
        open={createProjectOpen}
        onClose={() => setCreateProjectOpen(false)}
        onCreate={handleCreateProject}
      />

      {forkSource && <ComposerDialog title="创建聊天分支" onClose={() => { if (!forkPending) setForkSource(null); }}>
        <p className="composer-dialog-note">继承近期对话文本。已有工具执行、附件和文件变更记录留在原聊天。</p>
        <button type="button" className="composer-dialog-option" disabled={forkPending}
          onClick={() => void createChatFork('same-workspace')}>在当前工作区创建</button>
        <button type="button" className="composer-dialog-option" disabled={forkPending || !gitStatus?.available}
          onClick={() => void createChatFork('new-worktree')}>从已提交版本创建 Git 工作树</button>
        {forkPending && <p className="composer-dialog-note" role="status">正在创建聊天分支…</p>}
      </ComposerDialog>}
      {feedbackDraft !== null && <ComposerDialog title="聊天反馈" onClose={() => setFeedbackDraft(null)}>
        <p className="composer-dialog-note">导出本地 Markdown。仅包含你填写的反馈。</p>
        <label className="composer-dialog-field">反馈内容
          <textarea value={feedbackDraft} maxLength={4000} onChange={(event) => setFeedbackDraft(event.currentTarget.value)} />
        </label>
        <div className="composer-dialog-actions">
          <button type="button" className="codex-toolbar-btn" data-variant="primary" disabled={!feedbackDraft.trim()}
            onClick={exportFeedback}>导出反馈</button>
        </div>
      </ComposerDialog>}
      <ToastHost toasts={toasts} />
    </div>
    </PromptCacheProvider>
  );
};
