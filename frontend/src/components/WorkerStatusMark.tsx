import type { ReactNode } from 'react';
import type { Worker } from '../types/backend';

// Each outline remains distinguishable without color or motion.
const marks = {
  waiting: <circle cx="8" cy="8" r="5.75" strokeDasharray="1.8 2.2" />,
  running: <><circle cx="8" cy="8" r="5.75" /><path d="M8 4a4 4 0 0 1 0 8Z" fill="currentColor" stroke="none" /></>,
  done: <><circle cx="8" cy="8" r="5.75" /><path d="m5.4 8.1 1.7 1.7 3.6-3.7" /></>,
  failed: <><circle cx="8" cy="8" r="5.75" /><path d="m6.25 6.25 3.5 3.5m0-3.5-3.5 3.5" /></>,
  parked: <><circle cx="8" cy="8" r="5.75" /><path d="M6.5 6v4m3-4v4" /></>,
  interrupted: <path d="M5 3a5.75 5.75 0 1 0 6 0M8 2v5" />,
  cancelled: <><circle cx="8" cy="8" r="5.75" /><path d="m4.1 11.9 7.8-7.8" /></>,
  reconciling: <path d="M13.2 7a5.3 5.3 0 1 0-1.2 4.5M13.3 3.7v3.7H9.6" />,
  unknown: <><circle cx="8" cy="8" r="5.75" /><path d="M6.4 6.3a1.6 1.6 0 1 1 2.6 1.2c-.7.5-1 .8-1 1.4m0 1.8v.1" /></>,
} satisfies Record<Worker['status'], ReactNode>;

export function WorkerStatusMark({ status }: { status: Worker['status'] }) {
  return <svg className="worker-status-mark" data-state={status} width="14" height="14" viewBox="0 0 16 16"
    fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {marks[status] ?? marks.unknown}
  </svg>;
}
