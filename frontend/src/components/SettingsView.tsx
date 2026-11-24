import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { AgentBackendClient } from '../api/client';
import type {
  AppearancePreset,
  Approval,
  ConnectionSettings,
  EventEnvelope,
  MemoryItem,
  ModelSpec,
  PermissionMode,
  ProviderAccount,
  ProviderAccountInput,
  ProviderPresetCatalog,
  ProvidersHealth,
  ThemeMode,
  UsageItem,
  WorkspaceCustomizations,
} from '../types/backend';
import {
  fmtActionCommand,
  fmtClock,
  fmtStatusLabel,
  fmtTokens,
  fmtUSD,
} from '../utils/format';
import { AdaptiveContextPanel } from './AdaptiveContextPanel';
import { CheckinCenterPanel } from './CheckinCenterPanel';
import { ExperienceMemoryPanel } from './ExperienceMemoryPanel';
import {
  IconActivity,
  IconCheck,
  IconClose,
  IconCpu,
  IconDatabase,
  IconDownload,
  IconGlobe,
  IconKeyboard,
  IconSearch,
  IconSettingsGear,
  IconShieldCheck,
  IconSun,
  IconTerminal,
} from './Icons';
import { ModelManagementPanel } from './ModelManagementPanel';
import { ProviderAccountsPanel } from './ProviderAccountsPanel';

interface SettingsViewProps {
  client: AgentBackendClient;
  section: string;
  workspaceRoot?: string;
  themeMode: ThemeMode;
  preset: AppearancePreset;
  fontSize: 'compact' | 'default' | 'comfortable';
  reducedMotion: boolean;
  permissionMode: PermissionMode;
  connection: ConnectionSettings;
  backendHealthy: boolean | null;
  models: ModelSpec[];
  providersHealth: ProvidersHealth | null;
  providerPresets: ProviderPresetCatalog | null;
  providerAccounts: ProviderAccount[];
  providerAccountsLoading: boolean;
  onRefreshProviderAccounts: () => Promise<void>;
  onCreateProviderAccount: (
    input: ProviderAccountInput,
    opts?: { autoSync?: boolean },
  ) => Promise<void>;
  onUpdateProviderAccount: (id: string, patch: Partial<ProviderAccountInput>) => Promise<void>;
  onDeleteProviderAccount: (id: string) => Promise<void>;
  onBatchProviderAccounts?: (
    ids: string[],
    action: 'enable' | 'disable' | 'delete' | 'clear-cooldown',
  ) => Promise<void>;
  onReorderProviderGroups?: (order: string[]) => Promise<void>;
  onTestProviderAccount: (id: string) => Promise<void>;
  onSyncProviderAccount: (id: string) => Promise<void>;
  onQueryAccountBalance?: (id: string) => Promise<void>;
  onQueryAllBalances?: () => Promise<void>;
  onImportLocalProviderAccounts: () => Promise<void>;
  onModelsChanged: () => Promise<void>;
  onChangeWorkspaceRoot?: (path: string) => Promise<void>;
  approvals: Approval[];
  memory: MemoryItem[];
  usage: UsageItem[];
  recentEvents: EventEnvelope[];
  onChangeSection: (section: string) => void;
  onChangeThemeMode: (mode: ThemeMode) => void;
  onChangePreset: (preset: AppearancePreset) => void;
  onChangeFontSize: (size: 'compact' | 'default' | 'comfortable') => void;
  onChangeReducedMotion: (v: boolean) => void;
  onChangePermissionMode: (mode: PermissionMode) => void;
  onUpdateConnection: (conn: ConnectionSettings) => void;
  onTestConnection: (next?: ConnectionSettings) => Promise<void>;
  onDecideApproval: (approval: Approval, decision: 'approve' | 'deny') => Promise<void>;
  onOpenTask: (taskId: string) => void;
  onSearchMemory?: (query: string, scope: 'global' | 'workspace' | 'session') => Promise<void>;
  onDeleteMemory?: (item: MemoryItem) => Promise<void>;
  customizations?: WorkspaceCustomizations | null;
  onOpenExternalImport?: () => void;
  onToast: (msg: string, tone?: 'default' | 'success' | 'warning' | 'danger') => void;
}

const NAV_GROUPS: Array<{
  group: string;
  items: Array<{ id: string; label: string; icon: React.ReactNode }>;
}> = [
  {
    group: '模型与网关',
    items: [
      { id: 'providers', label: '账号池', icon: <IconGlobe size={15} /> },
      { id: 'models', label: '模型管理', icon: <IconCpu size={15} /> },
      { id: 'checkin', label: '签到中心', icon: <IconCheck size={15} /> },
    ],
  },
  {
    group: '工作区',
    items: [
      { id: 'approvals', label: '审批中心', icon: <IconShieldCheck size={15} /> },
      { id: 'memory', label: '记忆中心', icon: <IconDatabase size={15} /> },
      { id: 'context', label: '自适应上下文', icon: <IconCpu size={15} /> },
      { id: 'usage', label: '用量与费用', icon: <IconActivity size={15} /> },
      { id: 'connection', label: '连接与端点', icon: <IconTerminal size={15} /> },
    ],
  },
  {
    group: '个人与系统',
    items: [
      { id: 'general', label: '常规', icon: <IconSettingsGear size={15} /> },
      { id: 'appearance', label: '外观', icon: <IconSun size={15} /> },
      { id: 'shortcuts', label: '键盘快捷键', icon: <IconKeyboard size={15} /> },
      { id: 'environment', label: '安全护栏', icon: <IconShieldCheck size={15} /> },
      { id: 'events', label: '事件流诊断', icon: <IconActivity size={15} /> },
    ],
  },
];

const PRESETS: Array<{ id: AppearancePreset; name: string; swatch: string }> = [
  { id: 'codex', name: 'Codex 默认', swatch: '#0169cc' },
  { id: 'linear', name: 'Linear', swatch: '#5e6ad2' },
  { id: 'vercel', name: 'Vercel', swatch: '#006aff' },
  { id: 'catppuccin', name: 'Catppuccin', swatch: '#8839ef' },
  { id: 'tokyo-night', name: 'Tokyo Night', swatch: '#7aa2f7' },
  { id: 'github', name: 'GitHub', swatch: '#0969da' },
  { id: 'dracula', name: 'Dracula', swatch: '#bd93f9' },
  { id: 'nord', name: 'Nord', swatch: '#88c0d0' },
  { id: 'rose-pine', name: 'Rosé Pine', swatch: '#b4637a' },
  { id: 'raycast', name: 'Raycast', swatch: '#ff6363' },
];

const WIDE_SECTIONS = new Set(['providers', 'models', 'checkin']);

const ToggleSwitch: React.FC<{ checked: boolean; onChange: (next: boolean) => void; label: string }> = ({
  checked,
  onChange,
  label,
}) => (
  <button
    type="button"
    role="switch"
    aria-label={label}
    aria-checked={checked}
    className="codex-switch"
    onClick={() => onChange(!checked)}
  >
    <span className="codex-switch-thumb" />
  </button>
);

export const SettingsView: React.FC<SettingsViewProps> = ({
  client,
  section,
  workspaceRoot = '',
  themeMode,
  preset,
  fontSize,
  reducedMotion,
  permissionMode,
  connection,
  backendHealthy,
  providersHealth,
  providerPresets,
  providerAccounts,
  providerAccountsLoading,
  onRefreshProviderAccounts,
  onCreateProviderAccount,
  onUpdateProviderAccount,
  onDeleteProviderAccount,
  onBatchProviderAccounts,
  onReorderProviderGroups,
  onTestProviderAccount,
  onSyncProviderAccount,
  onQueryAccountBalance,
  onQueryAllBalances,
  onImportLocalProviderAccounts,
  onModelsChanged,
  onChangeWorkspaceRoot,
  approvals,
  memory,
  usage,
  recentEvents,
  onChangeSection,
  onChangeThemeMode,
  onChangePreset,
  onChangeFontSize,
  onChangeReducedMotion,
  onChangePermissionMode,
  onUpdateConnection,
  onTestConnection,
  onDecideApproval,
  onOpenTask,
  onSearchMemory,
  onDeleteMemory,
  customizations,
  onOpenExternalImport,
  onToast,
}) => {
  const [navSearch, setNavSearch] = useState('');
  const settingsNavRef = useRef<HTMLElement>(null);
  const settingsSearchRef = useRef<HTMLInputElement>(null);
  const settingsBodyRef = useRef<HTMLDivElement>(null);
  const [memoryQuery, setMemoryQuery] = useState('');
  const [memoryScope, setMemoryScope] = useState<'global' | 'workspace' | 'session'>('global');
  const [draftBaseUrl, setDraftBaseUrl] = useState(connection.baseUrl);
  const [draftToken, setDraftToken] = useState(connection.token);
  const [draftWorkspace, setDraftWorkspace] = useState<string | null>(null);
  const [workspaceSaving, setWorkspaceSaving] = useState(false);
  const [workspaceError, setWorkspaceError] = useState('');
  const pickWorkspace = async () => {
    try {
      const picked = await window.codexDesktop?.pickDirectory?.();
      if (picked) {
        setDraftWorkspace(picked.path);
        setWorkspaceError('');
      }
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : '无法选择目录');
    }
  };
  const applyWorkspace = async () => {
    if (!onChangeWorkspaceRoot || workspaceSaving) return;
    setWorkspaceSaving(true);
    setWorkspaceError('');
    try {
      await onChangeWorkspaceRoot((draftWorkspace ?? workspaceRoot).trim());
      setDraftWorkspace(null);
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : '无法切换工作区目录');
    } finally {
      setWorkspaceSaving(false);
    }
  };
  const [testing, setTesting] = useState(false);
  const [memorySearching, setMemorySearching] = useState(false);

  const filteredGroups = useMemo(() => {
    const q = navSearch.trim().toLowerCase();
    if (!q) return NAV_GROUPS;
    return NAV_GROUPS.map((g) => ({
      ...g,
      items: g.items.filter(
        (it) => it.label.toLowerCase().includes(q) || g.group.toLowerCase().includes(q),
      ),
    })).filter((g) => g.items.length > 0);
  }, [navSearch]);

  const validSections = new Set(NAV_GROUPS.flatMap((group) => group.items.map((item) => item.id)));
  const activeSection = validSections.has(section) ? section : 'general';
  const isWide = WIDE_SECTIONS.has(activeSection);
  useLayoutEffect(() => {
    if (settingsBodyRef.current) settingsBodyRef.current.scrollTop = 0;
  }, [activeSection]);
  useEffect(() => {
    const nav = settingsNavRef.current;
    if (!nav || (nav.scrollWidth <= nav.clientWidth && nav.scrollHeight <= nav.clientHeight)) return;
    const active = nav.querySelector('[aria-current="page"]');
    if (!active) return;
    const row = active.getBoundingClientRect();
    const bounds = nav.getBoundingClientRect();
    if (row.left < bounds.left) nav.scrollLeft += row.left - bounds.left - 4;
    if (row.right > bounds.right) nav.scrollLeft += row.right - bounds.right + 4;
    if (row.top < bounds.top) nav.scrollTop += row.top - bounds.top - 4;
    if (row.bottom > bounds.bottom) nav.scrollTop += row.bottom - bounds.bottom + 4;
  }, [activeSection, filteredGroups]);
  const pendingApprovals = approvals.filter((a) => a.status === 'pending');

  const filteredMemory = useMemo(() => {
    const q = memoryQuery.trim().toLowerCase();
    if (!q) return memory;
    return memory.filter((m) => m.summary.toLowerCase().includes(q));
  }, [memory, memoryQuery]);

  const handleSaveConnection = async (e: React.FormEvent) => {
    e.preventDefault();
    const nextConnection: ConnectionSettings = {
      mode: 'live',
      baseUrl: draftBaseUrl.trim(),
      token: draftToken.trim(),
    };
    onUpdateConnection(nextConnection);
    setTesting(true);
    try {
      await onTestConnection(nextConnection);
    } catch (error) {
      onToast(`连接校验失败：${error instanceof Error ? error.message : '未知错误'}`, 'danger');
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="codex-settings codex-settings-page">
      {/* Left Settings Navigation */}
      <div className="codex-settings-nav">
        <h2 className="codex-settings-nav-title">设置</h2>

        <div className="codex-settings-search">
          <IconSearch size={14} />
          <input
            ref={settingsSearchRef}
            placeholder="搜索设置"
            aria-label="搜索设置"
            value={navSearch}
            onChange={(e) => setNavSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && navSearch) {
                e.stopPropagation();
                setNavSearch('');
              }
            }}
          />
          {navSearch && (
            <button type="button" className="codex-icon-btn" aria-label="清除设置搜索" onClick={() => {
              setNavSearch('');
              settingsSearchRef.current?.focus();
            }}><IconClose size={13} /></button>
          )}
        </div>

        <nav className="codex-settings-nav-list" ref={settingsNavRef} aria-label="设置分类">
          {filteredGroups.length === 0 && <p className="codex-settings-nav-empty" role="status">没有匹配的设置</p>}
          {filteredGroups.map((g) => (
            <div key={g.group} className="codex-settings-nav-group">
              <div className="codex-settings-group-label">{g.group}</div>
              {g.items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className="codex-settings-nav-item"
                  data-active={activeSection === item.id ? 'true' : undefined}
                  aria-current={activeSection === item.id ? 'page' : undefined}
                  onClick={() => onChangeSection(item.id)}
                >
                  <span className="codex-settings-nav-icon">
                    {item.icon}
                  </span>
                  <span>{item.label}</span>
                  {item.id === 'providers' && providerAccounts.length > 0 && (
                    <span style={{ marginLeft: 'auto', fontSize: 11.5, color: 'var(--text-tertiary)' }}>
                      {providerAccounts.filter((a) => a.enabled).length}
                    </span>
                  )}
                  {item.id === 'approvals' && pendingApprovals.length > 0 && (
                    <span
                      style={{
                        marginLeft: 'auto',
                        fontSize: 11,
                        padding: '0 6px',
                        borderRadius: 9999,
                        background: 'var(--color-warning-soft)',
                        color: 'var(--color-warning)',
                      }}
                    >
                      {pendingApprovals.length}
                    </span>
                  )}
                </button>
              ))}
            </div>
          ))}
        </nav>
      </div>

      {/* Right Settings Body (widens automatically for Account Pool / Models / Check-in) */}
      <div className="codex-settings-body" ref={settingsBodyRef}>
        <div key={activeSection} className="codex-settings-inner" data-wide={isWide ? 'true' : undefined}>
          {activeSection === 'providers' && (
            <ProviderAccountsPanel
              client={client}
              presets={providerPresets}
              accounts={providerAccounts}
              loading={providerAccountsLoading}
              onRefresh={async () => {
                await onRefreshProviderAccounts();
                await onModelsChanged();
              }}
              onCreate={onCreateProviderAccount}
              onUpdate={onUpdateProviderAccount}
              onDelete={onDeleteProviderAccount}
              onBatch={onBatchProviderAccounts}
              onReorderProviders={onReorderProviderGroups}
              onTest={onTestProviderAccount}
              onSync={onSyncProviderAccount}
              onQueryBalance={onQueryAccountBalance}
              onQueryAllBalances={onQueryAllBalances}
              onImportLocal={onImportLocalProviderAccounts}
              onNavigateModels={() => onChangeSection('models')}
              onToast={onToast}
            />
          )}

          {activeSection === 'models' && (
            <ModelManagementPanel
              client={client}
              presets={providerPresets}
              accounts={providerAccounts}
              onCreateAccount={onCreateProviderAccount}
              onModelsChanged={onModelsChanged}
              onToast={onToast}
            />
          )}

          {activeSection === 'checkin' && (
            <CheckinCenterPanel client={client} onToast={onToast} />
          )}

          {activeSection === 'general' && (
            <>
              <div className="codex-settings-heading">
                <div>
                  <h1 className="codex-settings-h1">常规</h1>
                  <p className="codex-settings-lede">
                    Claude Code 级直连多轮对话已设为默认模式；输入 `/plan` 可按需触发多步骤规划。
                  </p>
                </div>
              </div>

              <div className="codex-settings-section-title">本地工作区目录</div>
              <div className="codex-settings-card">
                <div className="codex-settings-row">
                  <div className="codex-settings-row-info">
                    <span className="codex-settings-row-label">新会话默认工作区</span>
                    <span className="codex-settings-row-desc">
                      已有会话继续使用创建时的目录。工具审批与操作系统的目录权限相互独立。
                    </span>
                  </div>
                  <div className="codex-settings-actions">
                    <input
                      className="codex-input"
                      style={{ width: 280 }}
                      aria-label="新会话默认工作区"
                      value={draftWorkspace ?? workspaceRoot}
                      disabled={workspaceSaving}
                      onChange={(e) => setDraftWorkspace(e.target.value)}
                      placeholder="例如：D:\Agent_US"
                    />
                    {onChangeWorkspaceRoot && window.codexDesktop?.pickDirectory && (
                      <button type="button" className="codex-toolbar-btn" disabled={workspaceSaving} onClick={() => void pickWorkspace()}>
                        选择目录
                      </button>
                    )}
                    {onChangeWorkspaceRoot && (
                      <button
                        type="button"
                        className="codex-toolbar-btn"
                        data-variant="primary"
                        disabled={workspaceSaving || !(draftWorkspace ?? workspaceRoot).trim()}
                        onClick={() => void applyWorkspace()}
                      >
                        {workspaceSaving ? '正在应用…' : '应用目录'}
                      </button>
                    )}
                  </div>
                </div>
              </div>

              {workspaceError && <p role="alert" className="codex-inline-error">{workspaceError}</p>}
              <div className="codex-settings-section-title">新会话默认工具权限</div>
              <div className="codex-settings-card">
                <div className="codex-settings-row">
                  <div className="codex-settings-row-info">
                    <span className="codex-settings-row-label">工具审批级别</span>
                    <span className="codex-settings-row-desc">
                      现有会话可以在输入框旁单独更改工具权限。权限模式不会绕过系统限制或安全规则。
                    </span>
                  </div>
                  <select
                    className="codex-select"
                    value={permissionMode}
                    onChange={(e) => onChangePermissionMode(e.target.value as PermissionMode)}
                  >
                    <option value="approval">请我批准（修改文件和命令需确认）</option>
                    <option value="auto-review">替我审查（低风险只读命令自动审查）</option>
                    <option value="full-access">完全访问权限（仍遵守安全规则）</option>
                    <option value="auto-safe">智能放行（兼容模式）</option>
                  </select>
                </div>
              </div>

              <div className="codex-settings-section-title">数据源</div>
              <div className="codex-settings-card">
                <div className="codex-settings-row">
                  <div className="codex-settings-row-info">
                    <span className="codex-settings-row-label">数据源模式</span>
                    <span className="codex-settings-row-desc">
                      实时对接 `backend/src/main.js`（Direct Agent + 号池路由 + SQLite WAL）
                    </span>
                  </div>
                  <div className="codex-settings-actions">
                    <button
                      type="button"
                      className="codex-toolbar-btn"
                      data-variant={connection.mode === 'live' ? 'primary' : 'outline'}
                      onClick={() => onUpdateConnection({ ...connection, mode: 'live' })}
                    >
                      实时后端
                    </button>
                    <button
                      type="button"
                      className="codex-toolbar-btn"
                      data-variant={connection.mode === 'demo' ? 'primary' : 'outline'}
                      onClick={() => onUpdateConnection({ ...connection, mode: 'demo' })}
                    >
                      本地演示
                    </button>
                  </div>
                </div>
              </div>

              <div className="codex-settings-section-title">外部配置与扩展</div>
              <div className="codex-settings-card">
                <div className="codex-settings-row">
                  <div className="codex-settings-row-info">
                    <span className="codex-settings-row-label">显式导入外部配置</span>
                    <span className="codex-settings-row-desc">
                      扫描 `~/.claude`（CLAUDE.md、commands、agents、MCP）与 `~/.codex`（AGENTS.md、skills），由你确认后再迁移为 Agent_US 原生项目命令、规则与技能。
                      {customizations && (
                        <> 当前已激活 {customizations.commands.length} 个命令、{customizations.skills.length} 项技能、{customizations.rules.length} 条规则。</>
                      )}
                    </span>
                  </div>
                  <div className="codex-settings-actions">
                    <button
                      type="button"
                      className="codex-toolbar-btn"
                      data-variant="primary"
                      disabled={!onOpenExternalImport}
                      onClick={() => onOpenExternalImport?.()}
                    >
                      <IconDownload size={13} />
                      <span>外部配置导入</span>
                    </button>
                  </div>
                </div>
              </div>
            </>
          )}

          {activeSection === 'appearance' && (
            <>
              <h1 className="codex-settings-h1">外观</h1>

              <div className="codex-settings-section-title">主题与排版</div>
              <div className="codex-settings-card">
                <div className="codex-settings-row">
                  <div className="codex-settings-row-info">
                    <span className="codex-settings-row-label">颜色主题</span>
                    <span className="codex-settings-row-desc">浅色、深色或跟随系统偏好</span>
                  </div>
                  <select
                    className="codex-select"
                    value={themeMode}
                    onChange={(e) => onChangeThemeMode(e.target.value as ThemeMode)}
                  >
                    <option value="light">浅色</option>
                    <option value="dark">深色</option>
                    <option value="system">跟随系统</option>
                  </select>
                </div>
                <div className="codex-settings-row">
                  <div className="codex-settings-row-info">
                    <span className="codex-settings-row-label">字体大小</span>
                    <span className="codex-settings-row-desc">调整会话正文与界面密度</span>
                  </div>
                  <select
                    className="codex-select"
                    value={fontSize}
                    onChange={(e) =>
                      onChangeFontSize(e.target.value as 'compact' | 'default' | 'comfortable')
                    }
                  >
                    <option value="compact">紧凑 (13px)</option>
                    <option value="default">默认 (14px / 16px)</option>
                    <option value="comfortable">宽松 (15px / 17px)</option>
                  </select>
                </div>
                <div className="codex-settings-row">
                  <div className="codex-settings-row-info">
                    <span className="codex-settings-row-label">减弱动效</span>
                    <span className="codex-settings-row-desc">关闭过渡、展开与扫光动画</span>
                  </div>
                  <ToggleSwitch
                    label="减弱动效"
                    checked={reducedMotion}
                    onChange={onChangeReducedMotion}
                  />
                </div>
              </div>

              <div className="codex-settings-section-title">Codex 预设主题</div>
              <div className="codex-settings-card">
                <div className="codex-preset-grid">
                  {PRESETS.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      className="codex-preset-chip"
                      data-active={preset === p.id ? 'true' : undefined}
                      onClick={() => onChangePreset(p.id)}
                    >
                      <span className="codex-preset-swatch" style={{ background: p.swatch }} />
                      <span>{p.name}</span>
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}

          {activeSection === 'shortcuts' && (
            <>
              <h1 className="codex-settings-h1">键盘快捷键</h1>
              <div className="codex-settings-card">
                {[
                  ['打开命令面板', '搜索聊天、文件、文本与操作', 'Ctrl + K'],
                  ['新建聊天', '回到主页发起新对话', 'Ctrl + N'],
                  ['切换侧边栏', '折叠/展开左侧对话历史', 'Ctrl + B'],
                  ['对话内查找', '在当前会话内查找匹配项', 'Ctrl + F'],
                  ['切换明暗主题', '在浅色与深色外观之间切换', 'Ctrl + Shift + L'],
                  ['打开设置', '快速打开号池与设置中心', 'Ctrl + ,'],
                  ['发送消息', '提交对话（Shift+Enter 换行，/plan 进入规划模式）', 'Enter'],
                ].map(([label, desc, kbd]) => (
                  <div key={label} className="codex-settings-row">
                    <div className="codex-settings-row-info">
                      <span className="codex-settings-row-label">{label}</span>
                      <span className="codex-settings-row-desc">{desc}</span>
                    </div>
                    <span className="codex-kbd">{kbd}</span>
                  </div>
                ))}
              </div>
            </>
          )}

          {activeSection === 'connection' && (
            <>
              <h1 className="codex-settings-h1">连接与端点</h1>
              <div className="codex-settings-section-title">Agent_US Backend 服务</div>
              <form className="codex-settings-card" onSubmit={handleSaveConnection}>
                <div className="codex-settings-row">
                  <div className="codex-settings-row-info">
                    <span className="codex-settings-row-label">运行状态</span>
                    <span className="codex-settings-row-desc">
                      {connection.mode === 'demo'
                        ? '当前处于本地模拟模式'
                        : backendHealthy
                          ? `已连接真实 Backend · 号池 ${providersHealth?.routerReady ? '已就绪' : '待添加账号与同步模型'}`
                          : '后端未启动或 Bearer Token 未通过鉴权'}
                    </span>
                  </div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button
                      type="button"
                      className="codex-toolbar-btn"
                      data-variant={connection.mode === 'live' ? 'primary' : 'outline'}
                      onClick={() => onUpdateConnection({ ...connection, mode: 'live' })}
                    >
                      实时后端
                    </button>
                    <button
                      type="button"
                      className="codex-toolbar-btn"
                      data-variant={connection.mode === 'demo' ? 'primary' : 'outline'}
                      onClick={() => onUpdateConnection({ ...connection, mode: 'demo' })}
                    >
                      演示模式
                    </button>
                  </div>
                </div>

                <div className="codex-settings-row">
                  <div className="codex-settings-row-info">
                    <span className="codex-settings-row-label">后端地址（留空走同源代理）</span>
                    <span className="codex-settings-row-desc">
                      由 Vite / Electron 转发 `/v1` 与 `/api/v1` 至 `http://127.0.0.1:8787`
                    </span>
                  </div>
                  <input
                    aria-label="后端地址"
                    className="codex-input"
                    style={{ width: 240 }}
                    placeholder="留空走同源代理"
                    value={draftBaseUrl}
                    onChange={(e) => setDraftBaseUrl(e.target.value)}
                  />
                </div>

                <div className="codex-settings-row">
                  <div className="codex-settings-row-info">
                    <span className="codex-settings-row-label">Core 启动密钥 (BACKEND_TOKEN)</span>
                    <span className="codex-settings-row-desc">
                      若已由 `start-dev.ps1` 或桌面壳自动注入则留空即可。
                    </span>
                  </div>
                  <input
                    type="password"
                    aria-label="Core 启动密钥"
                    className="codex-input"
                    style={{ width: 240 }}
                    placeholder="已由代理自动注入或手动填写…"
                    value={draftToken}
                    onChange={(e) => setDraftToken(e.target.value)}
                  />
                </div>

                <div className="codex-settings-row">
                  <div className="codex-settings-row-info">
                    <span className="codex-settings-row-label">连接并核验</span>
                    <span className="codex-settings-row-desc">
                      测试 `GET /v1/health`、`GET /v1/models` 与 `GET /v1/providers/health`
                    </span>
                  </div>
                  <button
                    type="submit"
                    className="codex-toolbar-btn"
                    data-variant="primary"
                    disabled={testing}
                  >
                    {testing ? '连接中…' : '连接'}
                  </button>
                </div>
              </form>
            </>
          )}

          {activeSection === 'approvals' && (
            <>
              <h1 className="codex-settings-h1">审批中心</h1>
              <div className="codex-settings-card">
                {approvals.length === 0 ? (
                  <div className="codex-settings-row">
                    <div className="codex-settings-row-info">
                      <span className="codex-settings-row-label">暂无待审批记录</span>
                      <span className="codex-settings-row-desc">
                        Agent 调用需要授权的写文件或终端命令时，一次性审批会实时同步出现在对话流与这里。
                      </span>
                    </div>
                  </div>
                ) : (
                  approvals.map((a) => (
                    <div key={a.id} className="codex-settings-row">
                      <div className="codex-settings-row-info">
                        <span className="codex-settings-row-label">
                          {a.tool} · {fmtStatusLabel(a.status)}
                        </span>
                        <span
                          className="codex-settings-row-desc"
                          style={{ fontFamily: 'var(--font-mono)' }}
                        >
                          {fmtActionCommand(a.tool, a.action)}
                        </span>
                      </div>
                      <div className="codex-settings-actions">
                        {a.status === 'pending' ? (
                          <>
                            <button
                              type="button"
                              className="codex-toolbar-btn"
                              data-variant="outline"
                              onClick={() => void onDecideApproval(a, 'deny')}
                            >
                              拒绝
                            </button>
                            <button
                              type="button"
                              className="codex-toolbar-btn"
                              data-variant="primary"
                              onClick={() => void onDecideApproval(a, 'approve')}
                            >
                              批准
                            </button>
                          </>
                        ) : (
                          a.taskId && (
                            <button
                              type="button"
                              className="codex-toolbar-btn"
                              data-variant="outline"
                              onClick={() => onOpenTask(a.taskId!)}
                            >
                              查看会话
                            </button>
                          )
                        )}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </>
          )}

          {activeSection === 'memory' && (
            <>
              <h1 className="codex-settings-h1">记忆中心</h1>
              <ExperienceMemoryPanel key={workspaceRoot} client={client} projectId={workspaceRoot} onToast={onToast} />
              <h2 className="memory-section-title">持久记忆</h2>
              <div className="codex-settings-actions" style={{ marginBottom: 12 }}>
                <select
                  aria-label="记忆范围"
                  className="codex-select"
                  value={memoryScope}
                  onChange={(e) => setMemoryScope(e.target.value as typeof memoryScope)}
                >
                  <option value="global">全局记忆</option>
                  <option value="workspace">工作区记忆</option>
                  <option value="session">当前会话记忆</option>
                </select>
                <input
                  className="codex-input"
                  aria-label="搜索记忆"
                  style={{ flex: '1 1 150px' }}
                  placeholder="搜索持久化记忆…"
                  value={memoryQuery}
                  onChange={(e) => setMemoryQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter' || !onSearchMemory) return;
                    e.preventDefault();
                    setMemorySearching(true);
                    void onSearchMemory(memoryQuery, memoryScope).finally(() =>
                      setMemorySearching(false),
                    );
                  }}
                />
                <button
                  type="button"
                  className="codex-toolbar-btn"
                  data-variant="outline"
                  disabled={memorySearching || !onSearchMemory}
                  onClick={() => {
                    if (!onSearchMemory) return;
                    setMemorySearching(true);
                    void onSearchMemory(memoryQuery, memoryScope).finally(() =>
                      setMemorySearching(false),
                    );
                  }}
                >
                  {memorySearching ? '检索中…' : '检索'}
                </button>
              </div>
              <div className="codex-settings-card">
                {filteredMemory.length === 0 ? (
                  <div className="codex-settings-row">
                    <div className="codex-settings-row-info">
                      <span className="codex-settings-row-label">暂无记忆条目</span>
                      <span className="codex-settings-row-desc">
                        系统按 global / workspace / session 作用域保存持久记忆。
                      </span>
                    </div>
                  </div>
                ) : (
                  filteredMemory.map((m) => (
                    <div key={m.id} className="codex-settings-row">
                      <div className="codex-settings-row-info">
                        <span className="codex-settings-row-label">{m.key || m.id}</span>
                        <span className="codex-settings-row-desc">{m.summary}</span>
                      </div>
                      {m.taskId && (
                        <button
                          type="button"
                          className="codex-toolbar-btn"
                          data-variant="outline"
                          onClick={() => onOpenTask(m.taskId!)}
                        >
                          打开会话
                        </button>
                      )}
                      {onDeleteMemory && m.key && (
                        <button
                          type="button"
                          className="codex-toolbar-btn"
                          data-variant="danger"
                          onClick={() => void onDeleteMemory(m)}
                        >
                          删除
                        </button>
                      )}
                    </div>
                  ))
                )}
              </div>
            </>
          )}

          {activeSection === 'context' && (
            <AdaptiveContextPanel client={client} onToast={onToast} />
          )}

          {activeSection === 'usage' && (
            <>
              <h1 className="codex-settings-h1">用量与费用</h1>
              <div className="codex-kpi-grid">
                <div className="codex-kpi-card">
                  <div className="codex-kpi-label">总输入 Tokens</div>
                  <div className="codex-kpi-value tabular-nums">
                    {fmtTokens(usage.reduce((s, u) => s + u.inputTokens, 0))}
                  </div>
                </div>
                <div className="codex-kpi-card">
                  <div className="codex-kpi-label">总输出 Tokens</div>
                  <div className="codex-kpi-value tabular-nums">
                    {fmtTokens(usage.reduce((s, u) => s + u.outputTokens, 0))}
                  </div>
                </div>
                <div className="codex-kpi-card">
                  <div className="codex-kpi-label">预估费用</div>
                  <div className="codex-kpi-value tabular-nums">
                    {fmtUSD(usage.reduce((s, u) => s + u.estimatedUSD, 0))}
                  </div>
                </div>
              </div>
              <div className="codex-settings-card">
                {usage.length === 0 ? (
                  <div className="codex-settings-row">
                    <div className="codex-settings-row-info">
                      <span className="codex-settings-row-label">暂无用量记录</span>
                      <span className="codex-settings-row-desc">
                        发起直连对话后，系统会自动记录每轮 Token 消耗与耗时。
                      </span>
                    </div>
                  </div>
                ) : (
                  usage.map((u) => (
                    <div key={u.id} className="codex-settings-row">
                      <div className="codex-settings-row-info">
                        <span className="codex-settings-row-label">
                          {u.provider} / {u.model}
                        </span>
                        <span className="codex-settings-row-desc tabular-nums">
                          输入 {fmtTokens(u.inputTokens)} · 输出 {fmtTokens(u.outputTokens)}
                        </span>
                      </div>
                      <span className="tabular-nums" style={{ fontWeight: 500 }}>
                        {fmtUSD(u.estimatedUSD)}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </>
          )}

          {activeSection === 'environment' && (
            <>
              <h1 className="codex-settings-h1">Agnes 安全护栏与运行时</h1>
              <div className="codex-settings-card">
                {[
                  ['直连多轮 Agent', '默认跳过强制 DAG 编排，直接进行流式多轮对话与本地代码编辑', '已启用'],
                  ['凭据加密与脱敏', '账号凭据使用本地派生密钥 AES-256-GCM 加密落盘，API 永不返回明文', '已启用'],
                  ['高危命令硬封锁', 'WeakMap 一次性执行凭证 + 破坏性命令（rm -rf /、写块设备、Fork 炸弹）前置拦截', '已启用'],
                  ['提示注入防护', '工具输出与外部网页强制包裹随机 Nonce <untrusted> 信封并折叠超长输出', '已启用'],
                  ['账本完整性', 'SQLite 事件账本全链路 RFC 8785 JCS + SHA-256 哈希链校验', '已启用'],
                ].map(([label, desc, badge]) => (
                  <div key={label} className="codex-settings-row">
                    <div className="codex-settings-row-info">
                      <span className="codex-settings-row-label">{label}</span>
                      <span className="codex-settings-row-desc">{desc}</span>
                    </div>
                    <span className="codex-status-chip">{badge}</span>
                  </div>
                ))}
              </div>
            </>
          )}

          {activeSection === 'events' && (
            <>
              <h1 className="codex-settings-h1">事件流诊断</h1>
              <div className="codex-settings-card">
                {recentEvents.length === 0 ? (
                  <div className="codex-settings-row">
                    <div className="codex-settings-row-info">
                      <span className="codex-settings-row-label">暂无 SSE 事件</span>
                      <span className="codex-settings-row-desc">
                        发起对话后，`/v1/stream` 的实时事件将按序显示在这里。
                      </span>
                    </div>
                  </div>
                ) : (
                  [...recentEvents].reverse().slice(0, 50).map((ev, idx) => (
                    <div key={`${ev.seq}-${ev.timestamp}-${idx}`} className="codex-settings-row">
                      <div className="codex-settings-row-info">
                        <span className="codex-settings-row-label" style={{ fontFamily: 'var(--font-mono)' }}>
                          #{ev.seq} · {ev.type}
                        </span>
                        <span className="codex-settings-row-desc" style={{ fontFamily: 'var(--font-mono)' }}>
                          {JSON.stringify(ev.payload).slice(0, 260)}
                        </span>
                      </div>
                      <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
                        {fmtClock(ev.timestamp)}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
