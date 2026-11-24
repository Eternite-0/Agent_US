import React, { useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { usePresence, usePresenceSnapshot } from '../hooks/usePresence';
import { IconClose } from './Icons';
import './composer-dialog-motion.css';

export function ComposerDialog({ open = true, title, onClose, children, className = '' }: React.PropsWithChildren<{
  open?: boolean;
  title: string;
  onClose: () => void;
  className?: string;
}>) {
  const heading = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const node = dialog.current;
    if (!open || !node) return;
    node.showModal();
    // Release the native top layer, modal focus trap, and restore focus at logical close.
    return () => node.close();
  }, [open]);
  const present = usePresence(open, dialog);
  const content = usePresenceSnapshot(open, { title, children });
  if (!present) return null;
  return createPortal(<>
    {!open && <div className="composer-dialog-exit-scrim" aria-hidden="true" inert />}
    <dialog ref={dialog} className={`composer-dialog ${className}`} aria-labelledby={heading}
      data-presence={open ? 'open' : 'exiting'} inert={!open} aria-hidden={!open || undefined}
      onCancel={(event) => { event.preventDefault(); if (open) onClose(); }}>
      <header className="composer-dialog-header">
        <h2 id={heading}>{content.title}</h2>
        <button type="button" className="codex-icon-btn" aria-label="关闭" onClick={open ? onClose : undefined}><IconClose /></button>
      </header>
      {content.children}
    </dialog>
  </>, document.body);
}

const SKETCH_COLORS = ['#1e293b', '#2563eb', '#0f766e', '#c2410c'];

export function SketchDialog({ open, onClose, onAttach }: { open: boolean; onClose: () => void; onAttach: (image: Blob) => void }) {
  const [wasOpen, setWasOpen] = useState(open);
  const [revision, setRevision] = useState(0);
  if (wasOpen !== open) {
    setWasOpen(open);
    // A rapid reopen starts a fresh sketch without clearing the exiting one early.
    if (open) setRevision((value) => value + 1);
  }
  return (
    <ComposerDialog open={open} title="绘图" className="composer-sketch-dialog" onClose={onClose}>
      <SketchPad key={revision} onAttach={onAttach} />
    </ComposerDialog>
  );
}

function SketchPad({ onAttach }: { onAttach: (image: Blob) => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const pointer = useRef<number | null>(null);
  const [color, setColor] = useState(SKETCH_COLORS[0]);
  const [hasInk, setHasInk] = useState(false);

  function draw(event: React.PointerEvent<HTMLCanvasElement>, start: boolean) {
    const board = event.currentTarget;
    const context = board.getContext('2d');
    if (!context) return;
    const bounds = board.getBoundingClientRect();
    const x = (event.clientX - bounds.left) * board.width / bounds.width;
    const y = (event.clientY - bounds.top) * board.height / bounds.height;
    if (start) {
      if (pointer.current !== null || event.button !== 0) return;
      pointer.current = event.pointerId;
      board.setPointerCapture(event.pointerId);
      context.strokeStyle = color;
      context.lineWidth = 4;
      context.lineCap = 'round';
      context.lineJoin = 'round';
      context.beginPath();
      context.moveTo(x, y);
      context.lineTo(x + 0.01, y);
      setHasInk(true);
    } else if (pointer.current === event.pointerId) {
      context.lineTo(x, y);
    } else {
      return;
    }
    context.stroke();
    context.beginPath();
    context.moveTo(x, y);
  }

  function finish(event: React.PointerEvent<HTMLCanvasElement>) {
    if (pointer.current === event.pointerId) pointer.current = null;
  }

  function attachSketch() {
    const board = canvas.current;
    if (!board) return;
    const image = document.createElement('canvas');
    image.width = board.width;
    image.height = board.height;
    const context = image.getContext('2d');
    if (!context) return;
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, image.width, image.height);
    context.drawImage(board, 0, 0);
    image.toBlob((blob) => { if (blob && board.closest('dialog')?.open) onAttach(blob); }, 'image/png');
  }

  return (
    <>
      <canvas ref={canvas} className="composer-sketch-canvas" width={1000} height={520} aria-label="草图画布"
        onPointerDown={(event) => draw(event, true)} onPointerMove={(event) => draw(event, false)}
        onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={finish} />
      <footer className="composer-dialog-actions">
        <div className="composer-sketch-colors" role="group" aria-label="画笔颜色">
          {SKETCH_COLORS.map((value, index) => (
            <button key={value} type="button" className="composer-sketch-color" style={{ background: value }}
              aria-label={['深灰', '蓝色', '绿色', '橙色'][index]} aria-pressed={color === value} onClick={() => setColor(value)} />
          ))}
        </div>
        <button type="button" className="codex-toolbar-btn" disabled={!hasInk} onClick={() => {
          const board = canvas.current;
          if (board) board.getContext('2d')?.clearRect(0, 0, board.width, board.height);
          setHasInk(false);
        }}>清空</button>
        <button type="button" className="codex-toolbar-btn" data-variant="primary" disabled={!hasInk} onClick={attachSketch}>添加草图</button>
      </footer>
    </>
  );
}
