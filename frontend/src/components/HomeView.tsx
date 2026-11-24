import type { CommandAvailability, MentionExtension, SlashCommand } from './slashCommands';
import React, { useEffect, useRef, useState } from 'react';
import type {
  GitStatus,
  CodexMode,
  EffortLevel,
  ModelSpec,
  PermissionMode,
  SessionPermissionMode,
  WorkspaceEntryKind,
  Project,
} from '../types/backend';
import { Composer } from './Composer';
import type { ComposerDraftStore } from '../utils/threadInteraction';
import {
  CodexCloudMark,
  IconCheck,
  IconClose,
  IconFolder,
  IconPlus,
  IconRefresh,
  IconSearch,
} from './Icons';

interface HomeViewProps {
  draftStore: ComposerDraftStore;
  codexMode: CodexMode;
  projects: Project[];
  selectedProject: Project | null;
  models: ModelSpec[];
  selectedModel: string;
  effort: EffortLevel;
  permissionMode: SessionPermissionMode;
  gitStatus?: GitStatus | null;
  gitError?: string;
  permissionPending?: boolean;
  mentionPlugins?: MentionExtension[];
  mentionSkills?: MentionExtension[];
  draftInjection?: { id: number; text: string; mode: 'replace' | 'append' } | null;
  submitting: boolean;
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
  onStartReview?: (baseBranch?: string) => Promise<void>;
  onSlashCommand: (command: SlashCommand) => void;
  commandAvailability?: CommandAvailability;
  searchMentionFiles?: (query: string, signal: AbortSignal, kind: WorkspaceEntryKind) => Promise<string[]>;
  onSubmitGoal: (goal: string, files: Record<string, string>) => Promise<boolean>;
  onSubmitTask: (text: string, files: Record<string, string>) => Promise<boolean | void>;
  onOpenSettings: (section?: string) => void;
}

const STARTERS = [
  { kind: 'explore', title: '探索并理解代码', prompt: '请带我了解这个项目的代码结构，指出入口文件、核心模块和它们之间的关系。先不要修改文件。' },
  { kind: 'build', title: '构建新功能、应用或工具', prompt: '我想在这个项目中构建一个新功能。请先了解现有结构，再帮我梳理实现方案。新功能是：' },
  { kind: 'review', title: '审查代码并提出修改建议', prompt: '请审查当前代码，按严重程度列出发现，标明文件和位置，并给出修改建议。先不要改动代码。' },
  { kind: 'fix', title: '修复问题和失败', prompt: '请帮我定位并修复下面的问题。先复现、说明根因，再实施最小修改并验证。问题描述：' },
] as const;

function StarterIcon({ kind }: { kind: typeof STARTERS[number]['kind'] }) {
  if (kind === 'review') return <IconRefresh size={16} />;
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {kind === 'explore' ? <>
        <path d="M4 12l14-7 2 5-14 5a2 2 0 01-2-3zM15.5 6.3l2 4.7M11 14l-3 6m5-6 3 6" />
      </> : kind === 'build' ? <>
        <path d="M11 11l-6 7a1.8 1.8 0 002.6 2.5l6-7M8 4c3-1 6 .1 7.5 2l4.5 4.5-3 3-2-2-2 1.5-3.5-3.5 1.5-2L8 4z" />
      </> : <>
        <path d="M9 6 7 3m8 3 2-3M4 9l3 2m10 0 3-2M4 17l3-1m10 0 3 1" />
        <rect x="7" y="6" width="10" height="15" rx="5" /><path d="M12 11v10M8 11h8" />
      </>}
    </svg>
  );
}

export const HomeView: React.FC<HomeViewProps> = ({
  draftStore,
  codexMode,
  projects,
  selectedProject,
  models,
  selectedModel,
  effort,
  permissionMode,
  gitStatus = null,
  gitError,
  permissionPending = false,
  mentionPlugins = [],
  mentionSkills = [],
  draftInjection = null,
  submitting,
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
  onStartReview,
  onSlashCommand,
  commandAvailability,
  searchMentionFiles,
  onSubmitGoal,
  onSubmitTask,
  onOpenSettings,
}) => {
  const [starterDraft, setStarterDraft] = useState<{
    injection: NonNullable<HomeViewProps['draftInjection']>;
    previousInjection: HomeViewProps['draftInjection'];
  } | null>(null);
  // A new external injection (e.g. from a task template) supersedes a homepage starter.
  const activeInjection = starterDraft && starterDraft.previousInjection === draftInjection
    ? starterDraft.injection : draftInjection;
  const starterPrompt = useRef<string | null>(null);
  useEffect(() => () => {
    // A starter is a template for this visit; keep user edits and attachments.
    if (starterPrompt.current !== null && draftStore.read().text === starterPrompt.current) {
      draftStore.update('text', '');
    }
  }, [draftStore]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [projectSearch, setProjectSearch] = useState('');
  const pickerRef = useRef<HTMLSpanElement>(null);

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
      <div className="codex-home-hero">
        <CodexCloudMark className="codex-home-mark" size={54} />
        {codexMode === 'Chat' ? (
          <h1 className="codex-hero-title">新对话</h1>
        ) : !selectedProject ? (
          <h1 className="codex-hero-title">要开发什么？</h1>
        ) : (
          <h1 className="codex-hero-title">
            <span>要在</span>
            <span style={{ position: 'relative', display: 'inline-block' }} ref={pickerRef}>
              <button
                type="button"
                className="codex-hero-project-btn"
                aria-expanded={pickerOpen}
                title={selectedProject.name}
                onClick={() => {
                  setProjectSearch('');
                  setPickerOpen((v) => !v);
                }}
              >
                <span className="codex-hero-project-name">{selectedProject.name}</span>
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
                        data-selected={selectedProject.id === p.id ? 'true' : undefined}
                        onClick={() => {
                          onSelectProject(p.id);
                          setPickerOpen(false);
                        }}
                      >
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                          <IconFolder size={14} style={{ color: 'var(--text-secondary)' }} />
                          <span>{p.name}</span>
                        </span>
                        {selectedProject.id === p.id && <IconCheck size={14} />}
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
            <span>{codexMode === 'Work' ? '内协作什么？' : '内开发什么？'}</span>
          </h1>
        )}

        {codexMode !== 'Chat' && (
          <div className="codex-home-starters" aria-label="开始开发" role="group">
            {STARTERS.map(({ kind, title, prompt }) => (
              <button key={kind} type="button" className="codex-home-starter" data-kind={kind}
                onClick={() => {
                  starterPrompt.current = prompt;
                  setStarterDraft(previous => ({
                    injection: { id: (previous?.injection.id ?? 0) + 1, text: prompt, mode: 'replace' },
                    previousInjection: draftInjection,
                  }));
                }}>
                <StarterIcon kind={kind} />
                <span>{title}</span>
              </button>
            ))}
          </div>
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
          draftStore={draftStore}
          codexMode={codexMode}
          projects={projects}
          selectedProject={selectedProject}
          models={models}
          selectedModel={selectedModel}
          effort={effort}
          permissionMode={permissionMode}
          gitStatus={gitStatus}
          gitError={gitError}
          permissionPending={permissionPending}
          mentionPlugins={mentionPlugins}
          mentionSkills={mentionSkills}
          draftInjection={activeInjection}
          submitting={submitting}
          onSelectProject={onSelectProject}
          onOpenCreateProject={onOpenCreateProject}
          onSelectModel={onSelectModel}
          onChangeEffort={onChangeEffort}
          onChangePermission={onChangePermission}
          onRefreshGitStatus={onRefreshGitStatus}
          onCheckoutGitBranch={onCheckoutGitBranch}
          onInitGitRepo={onInitGitRepo}
          onStartReview={onStartReview}
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
