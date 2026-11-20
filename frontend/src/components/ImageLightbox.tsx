import React, { useEffect, useState } from 'react';
import { IconChevronRight, IconClose, IconDownload } from './Icons';

export interface PreviewImageItem {
  id: string;
  src: string;
  name: string;
  caption?: string;
}

const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif|svg|bmp|ico)$/i;

export function isImagePath(path: string | undefined | null): boolean {
  if (!path) return false;
  return IMAGE_EXT_RE.test(path.trim().split('?')[0]);
}

export function guessImageMime(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.svg')) return 'image/svg+xml';
  if (lower.endsWith('.bmp')) return 'image/bmp';
  return 'image/png';
}

export function toImageDataUrl(path: string, b64OrUrl: string | undefined | null): string | null {
  if (!b64OrUrl) return null;
  const trimmed = b64OrUrl.trim();
  if (/^data:image\/(png|jpeg|jpg|webp|gif|svg\+xml|bmp);base64,/i.test(trimmed)) {
    return trimmed;
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  // Treat raw base64 payload from backend files/artifacts safely as data URL
  if (/^[A-Za-z0-9+/=\s]+$/.test(trimmed) && trimmed.length >= 16) {
    return `data:${guessImageMime(path)};base64,${trimmed.replace(/\s+/g, '')}`;
  }
  return null;
}

interface ImageLightboxProps {
  images: PreviewImageItem[];
  index: number | null;
  onChangeIndex: (next: number | null) => void;
}

export const ImageLightbox: React.FC<ImageLightboxProps> = ({
  images,
  index,
  onChangeIndex,
}) => {
  const [zoomed, setZoomed] = useState(false);

  useEffect(() => {
    setZoomed(false);
  }, [index]);

  useEffect(() => {
    if (index === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onChangeIndex(null);
      } else if (e.key === 'ArrowLeft' && images.length > 1) {
        onChangeIndex((index - 1 + images.length) % images.length);
      } else if (e.key === 'ArrowRight' && images.length > 1) {
        onChangeIndex((index + 1) % images.length);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [index, images.length, onChangeIndex]);

  if (index === null || !images[index]) return null;
  const current = images[index];

  const handleDownload = () => {
    const a = document.createElement('a');
    a.href = current.src;
    a.download = current.name || 'image.png';
    a.click();
  };

  return (
    <div
      className="codex-lightbox-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={`查看图像：${current.name}`}
      onClick={() => onChangeIndex(null)}
    >
      <div className="codex-lightbox-bar" onClick={(e) => e.stopPropagation()}>
        <div className="codex-lightbox-meta">
          <span className="codex-lightbox-title">{current.caption || current.name}</span>
          {images.length > 1 && (
            <span className="tabular-nums" style={{ fontSize: 12, opacity: 0.7 }}>
              {index + 1} / {images.length}
            </span>
          )}
        </div>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <button
            type="button"
            className="codex-lightbox-btn"
            onClick={() => setZoomed((z) => !z)}
            title={zoomed ? '适应窗口' : '放大查看'}
          >
            <span>{zoomed ? '适应窗口' : '1:1 放大'}</span>
          </button>
          <button
            type="button"
            className="codex-lightbox-btn"
            onClick={handleDownload}
            title="下载图像"
            aria-label="下载图像"
          >
            <IconDownload size={14} />
          </button>
          <button
            type="button"
            className="codex-lightbox-btn"
            onClick={() => onChangeIndex(null)}
            title="关闭 (Esc)"
            aria-label="关闭"
          >
            <IconClose size={14} />
          </button>
        </div>
      </div>

      <div className="codex-lightbox-stage" onClick={(e) => e.stopPropagation()}>
        {images.length > 1 && (
          <button
            type="button"
            className="codex-lightbox-nav"
            data-side="left"
            aria-label="上一张图像"
            onClick={() => onChangeIndex((index - 1 + images.length) % images.length)}
          >
            <IconChevronRight size={18} style={{ transform: 'rotate(180deg)' }} />
          </button>
        )}

        <img
          src={current.src}
          alt={current.name}
          className="codex-lightbox-img"
          data-zoomed={zoomed ? 'true' : undefined}
          onClick={() => setZoomed((z) => !z)}
        />

        {images.length > 1 && (
          <button
            type="button"
            className="codex-lightbox-nav"
            data-side="right"
            aria-label="下一张图像"
            onClick={() => onChangeIndex((index + 1) % images.length)}
          >
            <IconChevronRight size={18} />
          </button>
        )}
      </div>
    </div>
  );
};
