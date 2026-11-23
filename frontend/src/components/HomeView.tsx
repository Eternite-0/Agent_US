import type { CommandAvailability, MentionExtension, SlashCommand } from './slashCommands';
import React, { useEffect, useRef, useState } from 'react';
import type {
  GitStatus,
  CodexMode,
  EffortLevel,
  ModelSpec,
  PermissionMode,
  WorkspaceEntryKind,
  Project,
} from '../types/backend';
import { Composer } from './Composer';
import {
  IconCheck,
  IconClose,
  IconFolder,
  IconPlus,
  IconRightPanelToggle,
  IconSearch,
} from './Icons';

interface HomeViewProps {
  codexMode: CodexMode;
  projects: Project[];
  selectedProject: Project | null;
  models: ModelSpec[];
  selectedModel: string;
  effort: EffortLevel;
  permissionMode: PermissionMode;
  gitStatus?: GitStatus | null;
  mentionPlugins?: MentionExtension[];
  mentionSkills?: MentionExtension[];
  draftInjection?: { id: number; text: string; mode: 'replace' | 'append' } | null;
  submitting: boolean;
  inspectorOpen: boolean;
  routerReady: boolean;
  isLiveBackend: boolean;
  onSelectProject: (projectId: string | null) => void;
  onOpenCreateProject: () => void;
  onSelectModel: (model: string) => void;
  onChangeEffort: (effort: EffortLevel) => void;
  onChangePermission: (mode: PermissionMode) => void;
  onRefreshGitStatus?: () => Promise<void>;
  onCheckoutGitBranch?: (branch: string, create?: boolean) => Promise<void>;
  onInitGitRepo?: () => Promise<void>;
  onSlashCommand: (command: SlashCommand) => void;
  commandAvailability?: CommandAvailability;
  searchMentionFiles?: (query: string, signal: AbortSignal, kind: WorkspaceEntryKind) => Promise<string[]>;
  onSubmitGoal: (goal: string, files: Record<string, string>) => Promise<boolean>;
  onSubmitTask: (text: string, files: Record<string, string>) => Promise<boolean | void>;
  onToggleInspector: () => void;
  onOpenSettings: (section?: string) => void;
}

export const HomeView: React.FC<HomeViewProps> = ({
  codexMode,
  projects,
  selectedProject,
  models,
  selectedModel,
  effort,
  permissionMode,
  gitStatus = null,
  mentionPlugins = [],
  mentionSkills = [],
  draftInjection = null,
  submitting,
  inspectorOpen,
  routerReady,
  isLiveBackend,
  onSelectProject,
  onOpenCreateProject,
  onSelectModel,
  onChangeEffort,
  onChangePermission,
  onRefreshGitStatus,
  onCheckoutGitBranch,
  onInitGitRepo,
  onSlashCommand,
  commandAvailability,
  searchMentionFiles,
  onSubmitGoal,
  onSubmitTask,
  onToggleInspector,
  onOpenSettings,
}) => {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [projectSearch, setProjectSearch] = useState('');
  const pickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!pickerOpen) return;
    const onDown = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setPickerOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPickerOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [pickerOpen]);

  const filteredProjects = projects.filter((p) =>
    p.name.toLowerCase().includes(projectSearch.trim().toLowerCase()),
  );

  return (
    <div className="codex-home">
      <div className="codex-home-top">
        <button
          type="button"
          className="codex-icon-btn"
          data-active={inspectorOpen ? 'true' : undefined}
          aria-label="切换右侧面板"
          title="切换右侧面板"
          onClick={onToggleInspector}
        >
          <IconRightPanelToggle size={16} />
        </button>
      </div>

      <div className="codex-home-hero">
        {codexMode === 'Chat' ? (
          <h1 className="codex-hero-title">新对话</h1>
        ) : (
          <h1 className="codex-hero-title">
            <span>{selectedProject ? '在' : '新对话 ·'}</span>
            <span style={{ position: 'relative', display: 'inline-block' }} ref={pickerRef}>
              <button
                type="button"
                className="codex-hero-project-btn"
                aria-expanded={pickerOpen}
                title={selectedProject?.name}
                onClick={() => {
                  setProjectSearch('');
                  setPickerOpen((v) => !v);
                }}
              >
                <span className="codex-hero-project-name">{selectedProject?.name || '选择项目'}</span>
              </button>

              {pickerOpen && (
                <div
                  className="codex-popover codex-project-popover"
                  data-side="bottom"
                  style={{
                    left: '50%',
                    transform: 'translateX(-50%)',
                    textAlign: 'left',
                  }}
                >
                  <div className="codex-project-popover-search">
                    <IconSearch size={14} style={{ flex: 'none' }} />
                    <input
                      autoFocus
                      placeholder="搜索项目"
                      value={projectSearch}
                      onChange={(e) => setProjectSearch(e.target.value)}
                    />
                  </div>
                  <div className="codex-project-popover-list">
                    {filteredProjects.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        className="codex-popover-item"
                        data-selected={selectedProject?.id === p.id ? 'true' : undefined}
                        onClick={() => {
                          onSelectProject(p.id);
                          setPickerOpen(false);
                        }}
                      >
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                          <IconFolder size={14} style={{ color: 'var(--text-secondary)' }} />
                          <span>{p.name}</span>
                        </span>
                        {selectedProject?.id === p.id && <IconCheck size={14} />}
                      </button>
                    ))}
                  </div>
                  <div className="codex-project-popover-footer">
                    <button
                      type="button"
                      className="codex-popover-item"
                      onClick={() => {
                        setPickerOpen(false);
                        onOpenCreateProject();
                      }}
                    >
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                        <IconPlus size={14} />
                        <span>新建项目</span>
                      </span>
                    </button>
                    <button
                      type="button"
                      className="codex-popover-item"
                      style={{ color: 'var(--text-secondary)' }}
                      onClick={() => {
                        onSelectProject(null);
                        setPickerOpen(false);
                      }}
                    >
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                        <IconClose size={14} />
                        <span>不在项目中工作</span>
                      </span>
                    </button>
                  </div>
                </div>
              )}
            </span>
            {selectedProject && <span>{codexMode === 'Work' ? '中开始协作' : '中开始对话'}</span>}
          </h1>
        )}

        {isLiveBackend && !routerReady && (
          <button
            type="button"
            className="codex-home-status"
            onClick={() => onOpenSettings('providers')}
          >
            <span className="codex-status-dot" data-tone="warn" />
            <span>配置模型以开始对话</span>
          </button>
        )}
      </div>

      <div className="codex-home-composer-slot">
        <Composer
          variant="home"
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
          draftInjection={draftInjection}
          submitting={submitting}
          onSelectProject={onSelectProject}
          onOpenCreateProject={onOpenCreateProject}
          onSelectModel={onSelectModel}
          onChangeEffort={onChangeEffort}
          onChangePermission={onChangePermission}
          onRefreshGitStatus={onRefreshGitStatus}
          onCheckoutGitBranch={onCheckoutGitBranch}
          onInitGitRepo={onInitGitRepo}
          onSlashCommand={onSlashCommand}
          commandAvailability={commandAvailability}
          searchMentionFiles={searchMentionFiles}
          onSubmitGoal={onSubmitGoal}
          onSubmit={onSubmitTask}
        />
      </div>
    </div>
  );
};
