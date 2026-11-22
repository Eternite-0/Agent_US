import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { InspectorDrawer } from './components/InspectorDrawer';
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
  TaskBundle,
  ThemeMode,
  ToastItem,
  UsageItem,
  WorkspaceEntryKind,
} from './types/backend';
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
  const [sseState, setSseState] = useState<'connected' | 'reconnecting' | 'error'>('connected');

  const client: AgentBackendClient = useMemo(() => {
    if (connection.mode === 'demo') return simulatorRef.current!;
    return new LiveBackendClient(connection);
  }, [connection]);

  // Atomic navigation history stack (prevents index/stack desync on repeated clicks)
  const [nav, setNav] = useState<{ stack: AppView[]; index: number }>(() => ({
    stack: [parseHash()],
    index: 0,
  }));
  const view = nav.stack[nav.index] ?? { kind: 'home' };
  const gitSessionId = view.kind === 'thread' ? view.taskId : undefined;

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
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(248);
  const [drawerWidth, setDrawerWidth] = useState(640);
  const [searchOpen, setSearchOpen] = useState(false);
  const [createProjectOpen, setCreateProjectOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [preferredSwarmRun, setPreferredSwarmRun] = useState<{ sessionId: string; runId: string } | null>(null);
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
  const archiveRequests = useRef(new Set<string>());
  const archiveGeneration = useRef(0);
  const currentClient = useRef(client);
  currentClient.current = client;
  const [archiveRevision, setArchiveRevision] = useState(0);
  const [scheduledTasks, setScheduledTasks] = useState<ScheduledTaskItem[]>([]);
  const [threadChains, setThreadChains] = useState<Record<string, string[]>>({});
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
  const [liveStreams, setLiveStreams] = useState<Record<string, { text: string; reasoning: string }>>({});
  const [liveToolOutputs, setLiveToolOutputs] = useState<Record<string, { callId: string; name: string; text: string }>>({});
  const [gitState, setGitState] = useState<{ sessionId?: string; status: GitStatus } | null>(null);
  const gitStatus = gitState?.sessionId === gitSessionId ? gitState?.status ?? null : null;

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
  const [activeBundles, setActiveBundles] = useState<TaskBundle[]>([]);
  const [bundleLoading, setBundleLoading] = useState(false);
  const [loadedChainKey, setLoadedChainKey] = useState<string | null>(null);
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
        setSidebarCollapsed((v) => !v);
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
  }, [navigate]);

  const toggleTheme = useCallback(() => {
    setThemeMode(resolvedTheme === 'dark' ? 'light' : 'dark');
  }, [resolvedTheme]);

  // Refresh global workspace collections from live backend (or demo engine if explicitly toggled)
  const refreshWorkspace = useCallback(
    async (notifyOnFailure = false) => {
      try {
        const health = await client.health();
        const archiveVersion = archiveGeneration.current;
        setBackendHealthy(health.ok ?? health.status === "ok");
        if (health.workspaceRoot) setWorkspaceRoot(health.workspaceRoot);
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

        setProjects(projList);
        if (currentClient.current === client && archiveVersion === archiveGeneration.current) {
          setTasks([...taskList].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)));
        }
        setApprovals(apprList);
        setModels(modelList);
        setProvidersHealth(pHealth);
        setMemory(memList);
        setUsage(usgList);
        if (schedList) {
          setScheduledTasks(schedList.map(hydrateScheduleItem));
        }
        if (evList.length) {
          setRecentEvents((prev) => {
            const bySeq = new Map<number, EventEnvelope>();
            for (const e of prev) bySeq.set(e.seq, e);
            for (const e of evList) bySeq.set(e.seq, e);
            return [...bySeq.values()].sort((a, b) => a.seq - b.seq).slice(-120);
          });
        }

        setSelectedProjectId((cur) => {
          if (cur && projList.some((p) => p.id === cur)) return cur;
          return workedOutsideProject ? null : projList[0]?.id ?? null;
        });
      } catch (err) {
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
    [client, connection.mode, navigate, pushToast, workedOutsideProject],
  );

  const handleRefreshGitStatus = useCallback(async () => {
    if (!client.getGitStatus) return;
    try {
      const next = await client.getGitStatus(gitSessionId);
      setGitState({ sessionId: gitSessionId, status: next });
    } catch {
      // Keep previous status silently on transient poll error
    }
  }, [client, gitSessionId]);

  useEffect(() => {
    void handleRefreshGitStatus();
  }, [handleRefreshGitStatus, workspaceRoot]);

  const handleCheckoutGitBranch = useCallback(
    async (branch: string, create = false) => {
      if (!client.checkoutGitBranch) {
        pushToast('当前连接暂不支持切换 Git 分支', 'warning');
        throw new Error('当前连接暂不支持切换 Git 分支');
      }
      const next = await client.checkoutGitBranch(branch, create, gitSessionId);
      setGitState({ sessionId: gitSessionId, status: next });
      pushToast(
        create ? `已创建并检出分支 ${next.branch || branch}` : `已切换到分支 ${next.branch || branch}`,
        'success',
      );
    },
    [client, gitSessionId, pushToast],
  );

  const handleInitGitRepo = useCallback(async () => {
    if (!client.initGitRepo) {
      pushToast('当前连接暂不支持创建 Git 存储库', 'warning');
      return;
    }
    try {
      const next = await client.initGitRepo('main', gitSessionId);
      setGitState({ sessionId: gitSessionId, status: next });
      pushToast(`已创建 Git 存储库（当前分支：${next.branch || 'main'}）`, 'success');
    } catch (err) {
      const msg = err instanceof Error ? err.message : '创建 Git 存储库失败';
      pushToast(msg, 'danger');
    }
  }, [client, gitSessionId, pushToast]);

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
    if (!client.setWorkspace || !dirPath) return;
    const res = await client.setWorkspace(dirPath);
    setWorkspaceRoot(res.workspaceRoot);
    await refreshWorkspace(false);
    pushToast(`已切换本地工作区目录：${res.workspaceRoot}`, 'success');
  }, [client, pushToast, refreshWorkspace]);

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

  // Initial probe & bootstrap (stays in live mode when backend is reachable!)
  const didBootRef = useRef(false);
  useEffect(() => {
    const first = !didBootRef.current;
    didBootRef.current = true;
    void refreshWorkspace(first);
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

  // Active thread chain IDs
  const activeRootTaskId = view.kind === 'thread' ? view.taskId : null;
  const activeChainIds = useMemo(() => {
    if (!activeRootTaskId) return [];
    const extras = threadChains[activeRootTaskId] ?? [];
    return [activeRootTaskId, ...extras.filter((id) => id !== activeRootTaskId)];
  }, [activeRootTaskId, threadChains]);

  const activeChainKey = activeChainIds.join(',');

  const refreshActiveBundles = useCallback(
    async (taskIds: string[], silent = false) => {
      const key = taskIds.join(',');
      if (!taskIds.length) {
        setActiveBundles([]);
        setLoadedChainKey(null);
        return;
      }
      if (!silent) setBundleLoading(true);
      try {
        const loaded = await Promise.all(
          taskIds.map((id) => client.loadTaskBundle(id).catch(() => null)),
        );
        const valid = loaded.filter((b): b is TaskBundle => b !== null);
        setActiveBundles(valid);
        setLoadedChainKey(key);
      } finally {
        if (!silent) setBundleLoading(false);
      }
    },
    [client],
  );

  // When switching between Live <-> Demo mode, leave stale thread IDs from the previous engine cleanly
  const prevConnModeRef = useRef(connection.mode);
  useEffect(() => {
    if (prevConnModeRef.current !== connection.mode) {
      prevConnModeRef.current = connection.mode;
      setActiveBundles([]);
      setLoadedChainKey(null);
      if (view.kind === 'thread') {
        navigate({ kind: 'home' });
      }
    }
  }, [connection.mode, navigate, view.kind]);

  useEffect(() => {
    if (!activeChainIds.length) {
      setActiveBundles([]);
      setInspectorTaskId(null);
      return;
    }
    void refreshActiveBundles(activeChainIds, false);
  }, [activeChainIds, refreshActiveBundles]);

  // Live SSE Event Stream Subscription
  const activeChainRef = useRef<string[]>([]);
  activeChainRef.current = activeChainIds;

  useEffect(() => {
    let throttleTimer: number | null = null;
    const scheduleRefresh = () => {
      if (throttleTimer !== null) return;
      throttleTimer = window.setTimeout(() => {
        throttleTimer = null;
        void refreshWorkspace(false);
        if (activeChainRef.current.length) {
          void refreshActiveBundles(activeChainRef.current, true);
        }
      }, 120);
    };

    const unsubscribe = client.subscribeEvents(
      {},
      (ev) => {
        const sid = ev.taskId || (typeof ev.payload?.sessionId === 'string' ? ev.payload.sessionId : '');
        if (sid && ev.type === 'tool/output') {
          const chunk = String(ev.payload?.chunk ?? '');
          const callId = String(ev.payload?.callId ?? '');
          const name = String(ev.payload?.name ?? 'bash');
          if (chunk) {
            setLiveToolOutputs((prev) => {
              const cur = prev[sid];
              const base = cur && cur.callId === callId ? cur.text : '';
              const nextText = (base + chunk).slice(-12000);
              return { ...prev, [sid]: { callId, name, text: nextText } };
            });
          }
          return;
        }
        if (sid && (ev.type === 'assistant/delta' || ev.type === 'reasoning/delta')) {
          setLiveStreams((prev) => {
            const cur = prev[sid] ?? { text: '', reasoning: '' };
            return {
              ...prev,
              [sid]: {
                text: ev.type === 'assistant/delta' ? String(ev.payload?.text ?? (cur.text + String(ev.payload?.delta ?? ''))) : cur.text,
                reasoning: ev.type === 'reasoning/delta' ? String(ev.payload?.text ?? (cur.reasoning + String(ev.payload?.delta ?? ''))) : cur.reasoning,
              },
            };
          });
          return;
        }
        if (sid && (ev.type === 'tool/result' || ev.type === 'turn/completed' || ev.type === 'turn/failed' || ev.type === 'turn/cancelled' || ev.type === 'turn/parked')) {
          setLiveToolOutputs((prev) => {
            if (!prev[sid]) return prev;
            const next = { ...prev };
            delete next[sid];
            return next;
          });
        }
        if (sid && (ev.type === 'turn/completed' || ev.type === 'turn/failed' || ev.type === 'turn/cancelled' || ev.type === 'turn/parked' || ev.type === 'assistant/message')) {
          setLiveStreams((prev) => {
            if (!prev[sid]) return prev;
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
        // Track structural runtime/swarm/verifier events in recentEvents & refresh bundles cleanly
        setRecentEvents((prev) => {
          if (ev.seq > 0 && prev.some((x) => x.seq === ev.seq && x.type === ev.type)) return prev;
          return [...prev.slice(-119), ev];
        });
        if (
          ev.type !== 'turn/phase_changed' ||
          activeChainRef.current.includes(sid)
        ) {
          scheduleRefresh();
        }
      },
      (state) => setSseState(state),
    );

    return () => {
      if (throttleTimer !== null) window.clearTimeout(throttleTimer);
      unsubscribe();
    };
  }, [client, refreshWorkspace, refreshActiveBundles, pushToast]);

  // Domain Actions
  const handleSelectProject = useCallback((projectId: string | null) => {
    setSelectedProjectId(projectId);
    setWorkedOutsideProject(projectId === null);
  }, []);

  const handleCreateProject = async (name: string, sourceFolders: string[] = []) => {
    try {
      if (sourceFolders.length > 0 && client.setWorkspace) {
        const ws = await client.setWorkspace(sourceFolders[0]);
        setWorkspaceRoot(ws.workspaceRoot);
      }
      const p = await client.createProject(name);
      setProjects((prev) => [...prev, p]);
      setSelectedProjectId(p.id);
      setWorkedOutsideProject(false);
      pushToast(
        sourceFolders.length
          ? `已创建项目 ${p.name}（已关联 ${sourceFolders.length} 个源文件夹）`
          : `已创建项目 ${p.name}`,
        'success',
      );
    } catch (e) {
      pushToast(`创建项目失败：${e instanceof Error ? e.message : '未知错误'}`, 'danger');
    }
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

  const handleSubmitNewTask = async (text: string, files: Record<string, string>) => {
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

      setTasks((prev) => [task, ...prev.filter((t) => t.id !== task.id)]);
      navigate({ kind: 'thread', taskId: task.id });
    } catch (e) {
      pushToast(`提交任务失败：${e instanceof Error ? e.message : '未知错误'}`, 'danger');
    } finally {
      setSubmitting(false);
    }
  };

  // Multi-turn follow-up inside an existing ThreadView: appends Turn N+1 to the same conversation!
  const handleSubmitFollowup = async (text: string, files: Record<string, string>) => {
    if (!activeRootTaskId) {
      await handleSubmitNewTask(text, files);
      return;
    }
    setSubmitting(true);
    try {
      const currentRoot = tasks.find((t) => t.id === activeRootTaskId) ?? activeBundles[0]?.task;
      if (currentRoot?.status === 'running' && client.steerSession && !text.startsWith('/plan ') && Object.keys(files).length === 0) {
        const steered = await client.steerSession(activeRootTaskId, text);
        if (steered.steered) {
          pushToast('已实时注入纠偏指令，Agent 将在下一步生效', 'success');
          return;
        }
      }
      if (client.submitFollowupTurn) {
        const updated = await client.submitFollowupTurn(activeRootTaskId, text, {
          model: selectedModel || undefined,
          permissionMode,
          ...(Object.keys(files).length ? { files } : {}),
          effort,
          clientTurnId: randomIdempotencyKey(),
        });
        setTasks((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
        await refreshActiveBundles([activeRootTaskId], true);
        return;
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

      setTasks((prev) => [nextTask, ...prev.filter((t) => t.id !== nextTask.id)]);
      setThreadChains((prev) => ({
        ...prev,
        [activeRootTaskId]: [...(prev[activeRootTaskId] ?? []), nextTask.id],
      }));
      setInspectorTaskId(nextTask.id);
    } catch (e) {
      pushToast(`发送追问失败：${e instanceof Error ? e.message : '未知错误'}`, 'danger');
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
      setTasks((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
      if (activeChainRef.current.includes(updated.id)) {
        void refreshActiveBundles(activeChainRef.current, true);
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
        await refreshActiveBundles(activeChainRef.current, true);
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
        if (activeChainRef.current.length) {
          await refreshActiveBundles(activeChainRef.current, true);
        }
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
        if (activeChainRef.current.length) {
          await refreshActiveBundles(activeChainRef.current, true);
        }
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
    if (currentClient.current !== client || archiveRequests.current.has(taskId)) return false;
    archiveRequests.current.add(taskId);
    setArchiveBusy(new Set(archiveRequests.current.keys()));
    try {
      const updated = await client.setTaskArchived(taskId, archived);
      if (currentClient.current !== client) return false;
      archiveGeneration.current += 1;
      setTasks((prev) => {
        if (archived) return prev.filter((task) => task.id !== taskId);
        const current = prev.find((task) => task.id === taskId);
        return [{ ...(current ?? updated), archivedAt: updated.archivedAt }, ...prev.filter((task) => task.id !== taskId)]
          .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
      });
      setActiveBundles((prev) => prev.map((bundle) => bundle.task.id === taskId
        ? { ...bundle, task: { ...bundle.task, archivedAt: updated.archivedAt } }
        : bundle));
      setArchiveRevision((prev) => prev + 1);
      return true;
    } catch (error) {
      if (currentClient.current === client) {
        pushToast(`${archived ? '归档' : '恢复'}失败：${error instanceof Error ? error.message : '连接异常'}`, 'danger');
      }
      return false;
    } finally {
      archiveRequests.current.delete(taskId);
      setArchiveBusy(new Set(archiveRequests.current.keys()));
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
        goal, permissionMode, ...(activeRootTaskId ? { sessionId: activeRootTaskId } : { workspaceRoot: workspaceRoot || undefined }),
      });
      if (currentClient.current !== client) return true;
      navigate({ kind: 'thread', taskId: result.sessionId });
      setInspectorTaskId(result.sessionId);
      setPreferredSwarmRun(result);
      setSwarmSectionRequest({ section: 'plan' });
      setInspectorRequest((value) => value + 1);
      setInspectorTab('autonomous');
      setInspectorOpen(true);
      if (activeRootTaskId === result.sessionId) void refreshActiveBundles(activeChainRef.current, true);
      void refreshWorkspace(false);
      pushToast('自主任务已启动', 'success');
      return true;
    } catch (error) {
      if (currentClient.current === client) pushToast(`自主任务启动失败：${error instanceof Error ? error.message : '连接异常'}`, 'danger');
      return false;
    } finally {
      setSubmitting(false);
    }
  };

  const searchMentionFiles = useMemo(() => {
    if (!client.searchWorkspaceFiles) return undefined;
    return (query: string, signal: AbortSignal, kind: WorkspaceEntryKind) => client.searchWorkspaceFiles!(query, activeRootTaskId ?? undefined, signal, kind);
  }, [client, activeRootTaskId, workspaceRoot]);

  const slashTask = activeBundles.find(({ task }) => task.id === activeRootTaskId)?.task
    ?? tasks.find(({ id }) => id === activeRootTaskId);
  const archiveBlock = !slashTask ? '会话尚未加载' : archiveBusy.has(slashTask.id) ? '正在更新归档状态' : undefined;
  const swarmBlock = !client.listSwarmRuns ? '当前连接未提供自主任务' : undefined;
  const commandAvailability: CommandAvailability = {
    '/goal': !client.submitAutonomousGoal ? '当前连接未提供自主任务' : undefined,
    '/swarm': swarmBlock,
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
          setPermissionMode('approval');
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
      setTasks((previous) => [task, ...previous.filter((entry) => entry.id !== task.id)]);
      setPermissionMode('approval');
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
    ? activeBundles.find((bundle) => bundle.task.id === view.taskId && bundle.task.archivedAt != null)
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

  return (
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
        onToggleSidebar={() => setSidebarCollapsed((v) => !v)}
        onNewChat={() => navigate({ kind: 'home' })}
        onNewProject={() => setCreateProjectOpen(true)}
        onOpenSettings={(sec) => navigate({ kind: 'settings', section: sec || 'general' })}
        onOpenSearch={() => setSearchOpen(true)}
        onToggleTheme={toggleTheme}
        onToggleInspector={() => setInspectorOpen((v) => !v)}
        onRefresh={() => {
          void refreshWorkspace(false);
          if (activeChainRef.current.length) {
            void refreshActiveBundles(activeChainRef.current, true);
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
                onInitGitRepo={handleInitGitRepo}
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
                key={view.taskId}
                bundles={activeBundles.filter((b) => activeChainIds.includes(b.task.id))}
                loading={
                  bundleLoading ||
                  (activeChainIds.length > 0 && loadedChainKey !== activeChainKey)
                }
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
                permissionMode={permissionMode}
                gitStatus={gitStatus}
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
                onChangePermission={setPermissionMode}
                onRefreshGitStatus={handleRefreshGitStatus}
                onCheckoutGitBranch={handleCheckoutGitBranch}
                onInitGitRepo={handleInitGitRepo}
                onSlashCommand={handleSlashCommand}
                commandAvailability={commandAvailability}
                searchMentionFiles={searchMentionFiles}
                onSubmitGoal={handleSubmitGoal}
                onSubmitFollowup={handleSubmitFollowup}
                onControlTask={handleControlTask}
                archiving={archiveBusy.has(view.taskId)}
                onToggleArchive={(task) => void (task.archivedAt != null
                  ? handleRestoreArchived(task.id)
                  : handleArchiveTask(task.id))}
                onDecideApproval={handleDecideApproval}
                onOpenInspector={(tab, filePath, targetTaskId) => {
                  setInspectorTab(tab);
                  if (filePath) setInspectorFile(filePath);
                  if (targetTaskId) setInspectorTaskId(targetTaskId);
                  setInspectorOpen(true);
                }}
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
                onToast={(msg) => pushToast(msg)}
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
                  setTasks((prev) => [task, ...prev.filter((t) => t.id !== task.id)]);
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
                onChangeWorkspaceRoot={handleChangeWorkspaceRoot}
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
                  setConnection(next);
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
            preferredRunId={preferredSwarmRun?.sessionId === activeRootTaskId ? preferredSwarmRun?.runId : undefined}
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
  );
};
