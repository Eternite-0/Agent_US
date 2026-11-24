import React, { useState } from 'react';
import { IconCheck, IconCopy, IconFileDoc, IconImageInspect } from './Icons';
import { toImageDataUrl, type PreviewImageItem } from './ImageLightbox';

interface MarkdownProps {
  text: string;
  imageFiles?: Record<string, string>;
  onOpenFile?: (path: string) => void;
  onOpenImage?: (images: PreviewImageItem[], index: number) => void;
  onCopy?: (msg: string) => void;
}

function isSafeExternalUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

function renderInline(
  src: string,
  onOpenFile?: (path: string) => void,
): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*|\[[^\]]+\]\([^)\s]+\))/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let k = 0;

  while ((match = pattern.exec(src)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(src.slice(lastIndex, match.index));
    }
    const token = match[0];
    if (token.startsWith('`')) {
      nodes.push(
        <code key={k++} className="codex-inline-code">
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith('**')) {
      nodes.push(<strong key={k++}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith('*')) {
      nodes.push(<em key={k++}>{token.slice(1, -1)}</em>);
    } else if (token.startsWith('[')) {
      const m = token.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/);
      if (m) {
        const [, label, href] = m;
        if (href.startsWith('file://')) {
          const path = href.slice('file://'.length);
          nodes.push(
            <button
              key={k++}
              type="button"
              className="codex-file-chip"
              onClick={() => onOpenFile?.(path)}
            >
              <IconFileDoc size={14} />
              <span>{label}</span>
            </button>,
          );
        } else if (isSafeExternalUrl(href)) {
          nodes.push(
            <a
              key={k++}
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: 'var(--color-link)', textUnderlineOffset: 2 }}
            >
              {label}
            </a>,
          );
        } else {
          nodes.push(label);
        }
      } else {
        nodes.push(token);
      }
    }
    lastIndex = pattern.lastIndex;
  }

  if (lastIndex < src.length) {
    nodes.push(src.slice(lastIndex));
  }
  return nodes;
}

const CodeBlock: React.FC<{ lang: string; code: string; onCopy?: (msg: string) => void }> = ({
  lang,
  code,
  onCopy,
}) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      onCopy?.('已复制代码');
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      // clipboard unavailable
    }
  };

  return (
    <div className="codex-code-block">
      <div className="codex-code-header">
        <span>{lang || 'text'}</span>
        <button
          type="button"
          className="codex-toolbar-btn"
          style={{ height: 22, padding: '0 6px', fontSize: 12 }}
          onClick={handleCopy}
          aria-label="复制"
        >
          {copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
          <span>{copied ? '已复制' : '复制'}</span>
        </button>
      </div>
      <pre className="codex-code-pre" tabIndex={0} aria-label={`${lang || 'text'} 代码`}>
        <code>{code}</code>
      </pre>
    </div>
  );
};

export const Markdown: React.FC<MarkdownProps> = ({
  text,
  imageFiles,
  onOpenFile,
  onOpenImage,
  onCopy,
}) => {
  if (!text) return null;

  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const elements: React.ReactNode[] = [];
  let i = 0;
  let key = 0;

  const resolveImageSrc = (rawSrc: string): string | null => {
    const trimmed = rawSrc.trim();
    if (/^data:image\/(png|jpeg|jpg|webp|gif|svg\+xml|bmp);base64,/i.test(trimmed)) return trimmed;
    if (isSafeExternalUrl(trimmed)) return trimmed;
    if (imageFiles) {
      const normalized = trimmed.replace(/^file:\/\//, '').replace(/^\.\//, '');
      const direct = imageFiles[normalized] ?? imageFiles[normalized.split('/').pop() || ''];
      if (direct) return toImageDataUrl(normalized, direct);
    }
    return null;
  };

  const imagePattern = /^!\[([^\]]*)\]\(([^)\s]+)\)$/;
  const tableSeparator = /^\s*\|?[\s:-]+\|[\s|:-]*$/;
  // A streaming delta can end anywhere (including halfway through a fence info
  // string). Both a complete and an incomplete fence must advance the parser.
  const fencePattern = /^ {0,3}(`{3,}|~{3,})(.*)$/;

  while (i < lines.length) {
    const line = lines[i];

    // Standalone Markdown image: ![alt](src) -> exact Codex rounded thumbnail + caption link!
    const imgMatch = line.trim().match(imagePattern);
    if (imgMatch) {
      const [, alt, rawSrc] = imgMatch;
      const resolved = resolveImageSrc(rawSrc);
      if (resolved) {
        const imgItem: PreviewImageItem = {
          id: `md-img-${key}`,
          src: resolved,
          name: rawSrc.split('/').pop() || alt || 'image.png',
          caption: alt || rawSrc.split('/').pop() || '查看图像',
        };
        elements.push(
          <div key={key++} className="codex-md-image-block">
            <button
              type="button"
              className="codex-md-image-thumb-btn"
              title="点击放大查看图像"
              onClick={() => onOpenImage?.([imgItem], 0)}
            >
              <img src={resolved} alt={alt || imgItem.name} decoding="async" loading="lazy" className="codex-md-image-thumb" />
            </button>
            <button
              type="button"
              className="codex-md-image-link"
              onClick={() => onOpenImage?.([imgItem], 0)}
            >
              <IconImageInspect size={14} />
              <span>{alt || `查看 ${imgItem.name}`}</span>
            </button>
          </div>,
        );
        i++;
        continue;
      }
    }

    // Fenced code block
    const fence = line.match(fencePattern);
    if (fence) {
      const [marker, info] = [fence[1], fence[2]];
      const closingFence = new RegExp(`^ {0,3}${marker[0]}{${marker.length},}\\s*$`);
      const lang = info.trim().split(/\s+/, 1)[0];
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !closingFence.test(lines[i])) {
        codeLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++;
      elements.push(<CodeBlock key={key++} lang={lang} code={codeLines.join('\n')} onCopy={onCopy} />);
      continue;
    }

    if (!line.trim()) {
      i++;
      continue;
    }

    // Headings
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      const content = renderInline(heading[2], onOpenFile);
      if (level === 1) elements.push(<h1 key={key++}>{content}</h1>);
      else if (level === 2) elements.push(<h2 key={key++}>{content}</h2>);
      else if (level === 3) elements.push(<h3 key={key++}>{content}</h3>);
      else elements.push(<h4 key={key++}>{content}</h4>);
      i++;
      continue;
    }

    // Horizontal rule
    if (/^(-{3,}|\*{3,})$/.test(line.trim())) {
      elements.push(<hr key={key++} />);
      i++;
      continue;
    }

    // GFM Table
    if (
      line.includes('|') &&
      i + 1 < lines.length &&
      tableSeparator.test(lines[i + 1])
    ) {
      const splitRow = (r: string) =>
        r
          .trim()
          .replace(/^\|/, '')
          .replace(/\|$/, '')
          .split('|')
          .map((c) => c.trim());
      const headers = splitRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      elements.push(
        <div key={key++} className="codex-table-wrap" tabIndex={0} role="region" aria-label="表格">
          <table>
            <thead>
              <tr>
                {headers.map((h, idx) => (
                  <th key={idx}>{renderInline(h, onOpenFile)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, rIdx) => (
                <tr key={rIdx}>
                  {r.map((cell, cIdx) => (
                    <td key={cIdx}>{renderInline(cell, onOpenFile)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    // Blockquote
    if (/^>\s?/.test(line)) {
      const quoteLines: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      elements.push(
        <blockquote key={key++}>{renderInline(quoteLines.join(' '), onOpenFile)}</blockquote>,
      );
      continue;
    }

    // Unordered list
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s+/, ''));
        i++;
      }
      elements.push(
        <ul key={key++}>
          {items.map((item, idx) => (
            <li key={idx}>{renderInline(item, onOpenFile)}</li>
          ))}
        </ul>,
      );
      continue;
    }

    // Ordered list
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+[.)]\s+/, ''));
        i++;
      }
      elements.push(
        <ol key={key++}>
          {items.map((item, idx) => (
            <li key={idx}>{renderInline(item, onOpenFile)}</li>
          ))}
        </ol>,
      );
      continue;
    }

    // Paragraph
    const para: string[] = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !fencePattern.test(lines[i]) &&
      !imagePattern.test(lines[i].trim()) &&
      !/^(-{3,}|\*{3,})$/.test(lines[i].trim()) &&
      !(lines[i].includes('|') && i + 1 < lines.length && tableSeparator.test(lines[i + 1])) &&
      !/^#{1,4}\s+/.test(lines[i]) &&
      !/^>\s?/.test(lines[i]) &&
      !/^\s*[-*+]\s+/.test(lines[i]) &&
      !/^\s*\d+[.)]\s+/.test(lines[i])
    ) {
      para.push(lines[i]);
      i++;
    }
    elements.push(<p key={key++}>{renderInline(para.join(' '), onOpenFile)}</p>);
  }

  return <div className="codex-markdown">{elements}</div>;
};
