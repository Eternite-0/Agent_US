import React, { useEffect, useRef, useState } from 'react';
import {
  IconCheck,
  IconChevronDown,
  IconClose,
  IconFolder,
  IconFolderPlus,
} from './Icons';

interface CreateProjectModalProps {
  open: boolean;
  onClose: () => void;
  onCreate: (name: string, sourceFolders: string[]) => Promise<void>;
}

type SourceMode = 'local' | 'manual' | 'blank';

const SOURCE_MODES: Array<{ id: SourceMode; label: string; desc: string }> = [
  { id: 'local', label: '在此电脑上添加文件夹', desc: '从本机选择项目目录作为源文件夹' },
  { id: 'manual', label: '输入本地文件夹路径', desc: '直接粘贴目录路径，如 D:\\MyProject' },
  { id: 'blank', label: '创建空白工作区项目', desc: '仅在后端注册项目，不绑定本地目录' },
];

export const CreateProjectModal: React.FC<CreateProjectModalProps> = ({
  open,
  onClose,
  onCreate,
}) => {
  const [name, setName] = useState('');
  const [sourceMode, setSourceMode] = useState<SourceMode>('local');
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const [folders, setFolders] = useState<string[]>([]);
  const [manualPath, setManualPath] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const nameInputRef = useRef<HTMLInputElement>(null);
  const modeRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setName('');
    setSourceMode(window.codexDesktop?.pickDirectory ? 'local' : 'manual');
    setError('');
    setModeMenuOpen(false);
    setFolders([]);
    setManualPath('');
    setSubmitting(false);
    window.setTimeout(() => nameInputRef.current?.focus(), 20);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (modeMenuOpen) setModeMenuOpen(false);
        else onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, modeMenuOpen, onClose]);

  useEffect(() => {
    if (!modeMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (modeRef.current && !modeRef.current.contains(e.target as Node)) {
        setModeMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [modeMenuOpen]);

  if (!open) return null;

  const addFolderEntry = (folderPath: string, inferredName?: string) => {
    const clean = folderPath.trim();
    if (!clean) return;
    setFolders((prev) => (prev.includes(clean) ? prev : [...prev, clean]));
    if (!name.trim()) {
      const derived =
        inferredName ||
        clean
          .replace(/[\\/]+$/, '')
          .split(/[\\/]/)
          .pop() ||
        '';
      if (derived) setName(derived);
    }
  };

  const handlePickLocalFolder = async () => {
    setError('');
    try {
      if (window.codexDesktop?.pickDirectory) {
        const picked = await window.codexDesktop.pickDirectory();
        if (picked) addFolderEntry(picked.path, picked.name);
      } else {
        // A browser folder handle does not grant the backend access or expose an absolute path.
        setSourceMode('manual');
        setError('浏览器无法授权后端访问本地文件夹。请输入后端所在电脑上的绝对路径，或使用桌面应用选择目录。');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '无法选择目录');
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    setError('');
    try {
      const source = sourceMode === 'manual' && manualPath.trim() && !folders.includes(manualPath.trim())
        ? [...folders, manualPath.trim()] : folders;
      await onCreate(trimmed, sourceMode === 'blank' ? [] : source);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建项目失败');
    } finally {
      setSubmitting(false);
    }
  };

  const currentModeLabel =
    SOURCE_MODES.find((m) => m.id === sourceMode)?.label ?? '在此电脑上添加文件夹';

  return (
    <div
      className="codex-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="创建项目"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <form className="codex-modal-card" onSubmit={handleSubmit}>
        <div className="codex-modal-header">
          <h2 className="codex-modal-title">创建项目</h2>
          <button
            type="button"
            className="codex-icon-btn"
            style={{ width: 26, height: 26 }}
            aria-label="关闭"
            onClick={onClose}
          >
            <IconClose size={15} />
          </button>
        </div>

        {/* Project Name Input (Exact User Screenshot 3) */}
        <div className="codex-modal-input-box">
          <IconFolder size={16} style={{ flex: 'none' }} />
          <input
            ref={nameInputRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="项目名称"
            maxLength={180}
          />
        </div>

        {/* Source Folder Section (Exact User Screenshot 3) */}
        <div className="codex-modal-section-label">源文件夹</div>
        <div className="codex-source-folder-card">
          <div style={{ position: 'relative' }} ref={modeRef}>
            <button
              type="button"
              className="codex-source-mode-btn"
              onClick={() => setModeMenuOpen((v) => !v)}
            >
              <span>{currentModeLabel}</span>
              <IconChevronDown size={13} />
            </button>

            {modeMenuOpen && (
              <div
                className="codex-popover"
                data-side="bottom"
                style={{ left: '50%', transform: 'translateX(-50%)', width: 256 }}
              >
                {SOURCE_MODES.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    className="codex-popover-item"
                    data-selected={sourceMode === m.id ? 'true' : undefined}
                    onClick={() => {
                      setSourceMode(m.id);
                      setModeMenuOpen(false);
                    }}
                  >
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                      <span>{m.label}</span>
                      <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{m.desc}</span>
                    </div>
                    {sourceMode === m.id && <IconCheck size={14} />}
                  </button>
                ))}
              </div>
            )}
          </div>

          {sourceMode === 'local' && (
            <>
              <button
                type="button"
                className="codex-source-add-btn"
                onClick={() => void handlePickLocalFolder()}
              >
                <IconFolderPlus size={14} />
                <span>添加</span>
              </button>
            </>
          )}

          {sourceMode === 'manual' && (
            <div style={{ display: 'flex', gap: 6, width: '100%' }}>
              <input
                value={manualPath}
                onChange={(e) => setManualPath(e.target.value)}
                aria-label="后端工作区绝对路径"
                placeholder="输入后端电脑上的绝对路径"
                style={{
                  flex: 1,
                  height: 32,
                  padding: '0 10px',
                  borderRadius: 8,
                  border: '1px solid var(--border-default)',
                  background: 'var(--bg-surface)',
                  color: 'var(--text-default)',
                  fontSize: 12.5,
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addFolderEntry(manualPath);
                    setManualPath('');
                  }
                }}
              />
              <button
                type="button"
                className="codex-source-add-btn"
                onClick={() => {
                  addFolderEntry(manualPath);
                  setManualPath('');
                }}
              >
                添加
              </button>
            </div>
          )}

          {sourceMode === 'blank' && (
            <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
              将在 Agent 后端创建独立项目空间，稍后可随时附加文件
            </span>
          )}

          {folders.length > 0 && (
            <div className="codex-source-folder-list">
              {folders.map((f) => (
                <div key={f} className="codex-source-folder-row">
                  <span
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 7,
                      minWidth: 0,
                      overflow: 'hidden',
                    }}
                  >
                    <IconFolder size={14} style={{ color: 'var(--text-secondary)', flex: 'none' }} />
                    <span
                      style={{
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                      title={f}
                    >
                      {f}
                    </span>
                  </span>
                  <button
                    type="button"
                    className="codex-icon-btn"
                    style={{ width: 20, height: 20 }}
                    aria-label="移除文件夹"
                    onClick={() => setFolders((prev) => prev.filter((x) => x !== f))}
                  >
                    <IconClose size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {error && <p role="alert" className="codex-inline-error">{error}</p>}

        {/* Footer: 取消 + 创建项目 pill */}
        <div className="codex-modal-footer">
          <button type="button" className="codex-modal-cancel-btn" onClick={onClose}>
            取消
          </button>
          <button
            type="submit"
            className="codex-modal-primary-btn"
            disabled={!name.trim() || submitting}
          >
            {submitting ? '创建中…' : '创建项目'}
          </button>
        </div>
      </form>
    </div>
  );
};
