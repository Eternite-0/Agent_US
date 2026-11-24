import { IconCheck, IconCopy } from './Icons';

/** Equal-size layers keep the button's hit target and label stationary. */
export function CopyFeedbackIcon({ copied, size = 14 }: { copied: boolean; size?: number }) {
  return <span className="codex-copy-feedback" data-copied={copied || undefined} aria-hidden="true">
    <IconCopy size={size} />
    <IconCheck size={size} />
  </span>;
}
