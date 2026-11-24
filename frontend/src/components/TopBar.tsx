import React, { useEffect, useRef, useState } from 'react';
import {
  IconArrowBack,
  IconCheck,
  IconClose,
  IconDotsHorizontal,
  IconRightPanelToggle,
  IconSidebarToggle,
  IconWinMaximize,
  IconWinMinimize,
  IconWinRestore,
} from './Icons';

interface TopBarProps {
  workspaceLayout: boolean;
  libraryToolbarRef?: React.Ref<HTMLDivElement>;
  showInspectorToggle: boolean;
  inspectorOpen: boolean;
  canBack: boolean;
  canForward: boolean;
  sidebarCollapsed: boolean;
  connectionLabel: string;
  connectionTone: 'live' | 'demo' | 'warn' | 'danger';
  theme: 'light' | 'dark';
  onBack: () => void;
  onForward: () => void;
  onToggleSidebar: () => void;
  onNewChat: () => void;
  onNewProject: () => void;
  onOpenSettings: (section?: string) => void;
  onOpenSearch: () => void;
  onToggleTheme: () => void;
  onToggleInspector: () => void;
  onRefresh: () => void;
}

type MenuKey = 'file' | 'edit' | 'view' | 'help';

export const TopBar: React.FC<TopBarProps> = ({
  workspaceLayout,
  libraryToolbarRef,
  showInspectorToggle,
  inspectorOpen,
  canBack,
  canForward,
  sidebarCollapsed,
  connectionLabel,
  connectionTone,
  theme,
  onBack,
  onForward,
  onToggleSidebar,
  onNewChat,
  onNewProject,
  onOpenSettings,
  onOpenSearch,
  onToggleTheme,
  onToggleInspector,
  onRefresh,
}) => {
  const [openMenu, setOpenMenu] = useState<MenuKey | 'app' | null>(null);
  const [maximized, setMaximized] = useState(false);
  const barRef = useRef<HTMLDivElement>(null);
  const desktop = typeof window !== 'undefined' ? window.codexDesktop : undefined;

  useEffect(() => {
    if (!desktop) return;
    void desktop.isMaximized().then(setMaximized).catch(() => {});
    return desktop.onMaximizedChange(setMaximized);
  }, [desktop]);

  useEffect(() => {
    if (!openMenu) return;
    const onDown = (e: MouseEvent) => {
      if (barRef.current && !barRef.current.contains(e.target as Node)) {
        setOpenMenu(null);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpenMenu(null);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [openMenu]);

  const menus: Record<
    MenuKey,
    { label: string; items: Array<{ label: string; shortcut?: string; checked?: boolean; divider?: boolean; action?: () => void }> }
  > = {
    file: {
      label: '文件',
      items: [
        { label: '新聊天', shortcut: 'Ctrl+N', action: onNewChat },
        { label: '新建项目…', action: onNewProject },
        { divider: true, label: '' },
        { label: '设置…', shortcut: 'Ctrl+,', action: () => onOpenSettings('general') },
        { label: '连接配置…', action: () => onOpenSettings('connection') },
      ],
    },
    edit: {
      label: '编辑',
      items: [
        { label: '全局搜索与命令', shortcut: 'Ctrl+K', action: onOpenSearch },
        { label: '刷新当前视图', action: onRefresh },
      ],
    },
    view: {
      label: '视图',
      items: [
        { label: sidebarCollapsed ? '显示侧边栏' : '隐藏侧边栏', shortcut: 'Ctrl+B', action: onToggleSidebar },
        { label: '切换右侧变更面板', action: onToggleInspector },
        { divider: true, label: '' },
        { label: '深色外观', shortcut: 'Ctrl+Shift+L', checked: theme === 'dark', action: onToggleTheme },
      ],
    },
    help: {
      label: '帮助',
      items: [
        { label: '键盘快捷键', action: () => onOpenSettings('shortcuts') },
        { label: '后端 API 与健康状态', action: () => onOpenSettings('connection') },
        { label: '关于 Codex · Agent US', action: () => onOpenSettings('general') },
      ],
    },
  };

  const renderMenuItems = (key: MenuKey) => menus[key].items.map((item, idx) => item.divider ? (
    <div key={idx} className="codex-popover-divider" />
  ) : (
    <button key={idx} type="button" className="codex-popover-item" onClick={() => {
      setOpenMenu(null);
      item.action?.();
    }}>
      <span className="codex-menu-item-label">
        {item.checked !== undefined && <span className="codex-menu-check" data-checked={item.checked}><IconCheck size={14} /></span>}
        <span>{item.label}</span>
      </span>
      {item.shortcut && <span className="codex-menu-shortcut">{item.shortcut}</span>}
    </button>
  ));

  return (
    <header className="codex-topbar" data-library-toolbar={Boolean(libraryToolbarRef) || undefined} ref={barRef}>
      <div className="codex-topbar-left">
        <button
          type="button"
          className="codex-icon-btn"
          aria-label={sidebarCollapsed ? '显示侧边栏' : '隐藏侧边栏'}
          aria-expanded={!sidebarCollapsed}
          onClick={onToggleSidebar}
          title="切换侧边栏 (Ctrl+B)"
        >
          <IconSidebarToggle size={16} />
        </button>

        <div className="codex-topbar-nav">
          <button
            type="button"
            className="codex-icon-btn"
            aria-label="返回"
            disabled={!canBack}
            onClick={onBack}
            title="返回"
          >
            <IconArrowBack size={15} />
          </button>
          <button
            type="button"
            className="codex-icon-btn"
            aria-label="前进"
            disabled={!canForward}
            onClick={onForward}
            title="前进"
          >
            <IconArrowBack size={15} style={{ transform: 'scaleX(-1)' }} />
          </button>
        </div>

        {workspaceLayout ? (
          <div className="codex-app-menu">
            <button type="button" className="codex-icon-btn" aria-label="应用程序菜单"
              aria-expanded={openMenu === 'app'} onClick={() => setOpenMenu((cur) => cur === 'app' ? null : 'app')}>
              <IconDotsHorizontal size={16} />
            </button>
            {openMenu === 'app' && (
              <div className="codex-popover codex-app-menu-panel" data-side="bottom" aria-label="应用程序菜单">
                {(Object.keys(menus) as MenuKey[]).map((key) => (
                  <div key={key} role="group" aria-label={menus[key].label}>
                    <div className="codex-app-menu-section">{menus[key].label}</div>
                    {renderMenuItems(key)}
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          <nav className="codex-menubar" role="menubar" aria-label="应用程序菜单">
            {(Object.keys(menus) as MenuKey[]).map((key) => (
              <div key={key} style={{ position: 'relative' }}>
                <button type="button" role="menuitem" className="codex-menu-trigger"
                  data-open={openMenu === key ? 'true' : undefined}
                  onClick={() => setOpenMenu((cur) => (cur === key ? null : key))}
                  onMouseEnter={() => { if (openMenu && openMenu !== key) setOpenMenu(key); }}>
                  {menus[key].label}
                </button>
                {openMenu === key && (
                  <div className="codex-popover" data-side="bottom" style={{ left: 0, minWidth: 210 }}>
                    {renderMenuItems(key)}
                  </div>
                )}
              </div>
            ))}
          </nav>
        )}
      </div>

      {libraryToolbarRef && <div className="codex-topbar-library" ref={libraryToolbarRef} />}

      <div className="codex-topbar-right">
        <button
          type="button"
          className="codex-conn-pill"
          onClick={() => onOpenSettings('connection')}
          aria-label={connectionLabel}
          title={`${connectionLabel} · 点击配置连接`}
        >
          <span className="codex-status-dot" data-tone={connectionTone} />
          <span>{connectionLabel}</span>
        </button>

        {showInspectorToggle && (
          <button type="button" className="codex-icon-btn" data-active={inspectorOpen || undefined}
            title="切换右侧面板" aria-label="切换右侧面板" aria-expanded={inspectorOpen} onClick={onToggleInspector}>
            <IconRightPanelToggle size={16} />
          </button>
        )}

        {desktop && (
          <div className="codex-win-controls" aria-label="窗口控制">
            <button
              type="button"
              className="codex-win-btn"
              aria-label="最小化"
              title="最小化"
              onClick={() => void desktop.minimize()}
            >
              <IconWinMinimize size={11} />
            </button>
            <button
              type="button"
              className="codex-win-btn"
              aria-label={maximized ? '向下还原' : '最大化'}
              title={maximized ? '向下还原' : '最大化'}
              onClick={() => void desktop.toggleMaximize().then(setMaximized)}
            >
              {maximized ? <IconWinRestore size={11} /> : <IconWinMaximize size={11} />}
            </button>
            <button
              type="button"
              className="codex-win-btn"
              data-close="true"
              aria-label="关闭"
              title="关闭"
              onClick={() => void desktop.close()}
            >
              <IconClose size={13} />
            </button>
          </div>
        )}
      </div>
    </header>
  );
};
