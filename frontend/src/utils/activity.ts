import type {
  Approval,
  Assignment,
  EventEnvelope,
  Evidence,
  SessionHistoryItem,
  SessionRecord,
  TaskPlan,
  Worker,
} from '../types/backend';
import { computeDiff, decodeBase64Utf8, type DiffLine } from './diff';
import { fmtActionCommand } from './format';
import {
  getWorkerActivityLabel,
  getWorkerDisplayName,
  getWorkerDisplayRole,
  resolveWorkerForPayload,
  resolveWorkerIdFromPayload,
} from './worker';

export interface UnifiedPlanNode {
  nodeId: string;
  displayName: string;
  displayRole: string;
  objective: string;
  activityLabel: string;
  status: 'pending' | 'queued' | 'running' | 'awaiting_approval' | 'done' | 'failed' | 'cancelled';
  workerId?: string;
}

export interface UnifiedPlanSummary {
  title?: string;
  complexity?: string;
  risk?: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  nodes: UnifiedPlanNode[];
}

export interface ActivityImageItem {
  id: string;
  path: string;
  name: string;
  rawBase64?: string;
}

export type UnifiedActivityItem =
  | {
      kind: 'command';
      id: string;
      seq: number;
      timestamp: number;
      order: number;
      callId?: string;
      toolName: string;
      command: string;
      output?: string;
      error?: string;
      exitCode?: number;
      status: 'running' | 'completed' | 'failed';
      startedAt?: number;
      durationMs?: number;
      worker?: Worker;
      workerLabel: string;
      eventType: string;
      filePath?: string;
    }
  | {
      kind: 'file';
      id: string;
      seq: number;
      timestamp: number;
      order: number;
      callId?: string;
      operation: 'read' | 'write' | 'patch';
      path: string;
      base: string;
      added?: number;
      deleted?: number;
      isCreated?: boolean;
      status: 'running' | 'completed' | 'failed';
      summary?: string;
      errorNote?: string;
      afterText?: string;
      diffLines?: DiffLine[];
      previewLines?: string[];
      worker?: Worker;
      workerLabel: string;
      eventType: string;
    }
  | {
      kind: 'worker';
      id: string;
      seq: number;
      timestamp: number;
      order: number;
      phase: 'started' | 'completed' | 'failed' | 'resumed';
      workerKey: string;
      worker?: Worker;
      workers?: Array<{ worker: Worker; label: string }>;
      label: string;
      role: string;
      activityLabel?: string;
      eventType: string;
    }
  | {
      kind: 'approval';
      id: string;
      seq: number;
      timestamp: number;
      order: number;
      approvalId: string;
      tool: string;
      command?: string;
      status: 'pending' | 'approved' | 'denied';
      reason?: string;
      worker?: Worker;
      workerLabel: string;
      eventType: string;
    }
  | {
      kind: 'image-view';
      id: string;
      seq: number;
      timestamp: number;
      order: number;
      images: ActivityImageItem[];
    }
  | {
      kind: 'commentary';
      id: string;
      seq: number;
      timestamp: number;
      order: number;
      role: string;
      text: string;
    }
  | {
      kind: 'error';
      id: string;
      seq: number;
      timestamp: number;
      order: number;
      title: string;
      message: string;
      worker?: Worker;
      workerLabel: string;
      eventType: string;
    }
  | {
      kind: 'compaction';
      id: string;
      seq: number;
      timestamp: number;
      order: number;
    };

export interface UnifiedTimelineInput {
  plan?: TaskPlan;
  assignments: Assignment[];
  workers: Worker[];
  sessions: SessionRecord[];
  histories: Record<string, SessionHistoryItem[]>;
  evidence: Evidence[];
  approvals: Approval[];
  taskFiles?: Record<string, string>;
  artifactFiles?: Record<string, string>;
  events: EventEnvelope[];
  startedAt?: number;
  isLive?: boolean;
  finalProseTexts?: string[];
  subagentMode?: boolean;
  isImagePath?: (path: string) => boolean;
}

export interface UnifiedTimelineResult {
  planSummary: UnifiedPlanSummary | null;
  items: UnifiedActivityItem[];
  hasCompaction: boolean;
}

function asText(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

export function normalizeFilePath(raw: string): string {
  return raw.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+/g, '/').trim();
}

export function isRawJsonPayload(text: string): boolean {
  const t = text.trim();
  if (!(t.startsWith('{') && t.endsWith('}')) && !(t.startsWith('[') && t.endsWith(']'))) {
    return false;
  }
  try {
    const parsed = JSON.parse(t);
    return typeof parsed === 'object' && parsed !== null;
  } catch {
    return false;
  }
}

export function sortEventsChronologically(events: EventEnvelope[]): EventEnvelope[] {
  return [...events].sort((a, b) => {
    if (a.seq > 0 && b.seq > 0 && a.seq !== b.seq) return a.seq - b.seq;
    if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
    return a.seq - b.seq;
  });
}

function isReadTool(name: string): boolean {
  const n = name.toLowerCase();
  return n === 'read_file' || n === 'file.read' || n === 'view_file';
}

function isWriteTool(name: string): boolean {
  const n = name.toLowerCase();
  return (
    n === 'write_file'
    || n === 'edit_file'
    || n === 'patch_file'
    || n === 'apply_patch'
    || n === 'create_file'
    || n === 'file.write'
    || n === 'file.patch'
  );
}

function defaultIsImagePath(path: string): boolean {
  return /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i.test(path.trim());
}

interface ParsedToolContent {
  output?: string;
  error?: string;
  exitCode?: number;
  path?: string;
  added?: number;
  deleted?: number;
  summary?: string;
}

function parseToolResultContent(raw: unknown): ParsedToolContent {
  if (typeof raw !== 'string' || !raw.trim()) return {};
  const trimmed = raw.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      const stdout = asText(obj.stdout);
      const stderr = asText(obj.stderr);
      const outText = asText(obj.output) || asText(obj.content) || asText(obj.status) || asText(obj.diff);
      const combined = [stdout, stderr].filter(Boolean).join('\n') || outText;
      const err = asText(obj.error) || asText(obj.message);
      const exitCode = typeof obj.exitCode === 'number' ? obj.exitCode : undefined;
      const path = asText(obj.path) || asText(obj.filePath) || asText(obj.written) || undefined;
      const added = typeof obj.added === 'number' ? obj.added : undefined;
      const deleted = typeof obj.deleted === 'number' ? obj.deleted : undefined;
      const summary = asText(obj.summary) || undefined;
      return {
        output: combined || (!err ? trimmed : undefined),
        error: err || undefined,
        exitCode,
        path,
        added,
        deleted,
        summary,
      };
    } catch {
      // fall through to plain text
    }
  }
  return { output: trimmed };
}

function extractCommandFromArgs(toolName: string, args: Record<string, unknown> | null): string {
  if (!args) return '';
  if (typeof args.command === 'string' && args.command.trim()) return args.command.trim();
  if (typeof args.cmd === 'string' && args.cmd.trim()) return args.cmd.trim();
  if (Array.isArray(args.argv) && args.argv.length) return args.argv.map(String).join(' ');
  if (Array.isArray(args.args) && args.args.length) {
    return `${toolName} ${args.args.map(String).join(' ')}`.trim();
  }
  if (typeof args.path === 'string' && args.path.trim()) return `${toolName} ${args.path.trim()}`;
  return '';
}

function extractApprovalId(payload: Record<string, unknown>): string {
  const direct = asText(payload.approvalId).trim();
  if (direct) return direct;
  if (payload.approval && typeof payload.approval === 'object') {
    const nested = asText((payload.approval as Record<string, unknown>).id).trim();
    if (nested) return nested;
  }
  return asText(payload.id).trim();
}

function mapAssignmentStatus(status?: Assignment['status']): UnifiedPlanNode['status'] {
  if (status === 'done') return 'done';
  if (status === 'failed') return 'failed';
  if (status === 'running') return 'running';
  if (status === 'queued') return 'queued';
  return 'pending';
}

export function buildUnifiedActivityTimeline(input: UnifiedTimelineInput): UnifiedTimelineResult {
  const {
    plan,
    assignments,
    workers,
    sessions,
    histories,
    evidence,
    approvals,
    taskFiles,
    artifactFiles,
    events,
    startedAt = 0,
    isLive = false,
    finalProseTexts = [],
    subagentMode = false,
    isImagePath = defaultIsImagePath,
  } = input;

  const sortedEvents = sortEventsChronologically(events);
  const assignmentById = new Map(assignments.map((a) => [a.id, a]));
  const assignmentByKey = new Map(assignments.map((a) => [a.key, a]));
  const approvalById = new Map(approvals.map((a) => [a.id, a]));
  const workerById = new Map(workers.map((w) => [w.id, w]));
  const pendingExternalApprovalIds = new Set(
    approvals.filter((a) => a.status === 'pending').map((a) => a.id),
  );
  const finalProseSet = new Set(finalProseTexts.map((t) => t.trim()).filter(Boolean));

  // Identify the final assistant message event so we never duplicate the closing reply inside Activity
  let finalAssistantMessageSeq: number | null = null;
  if (!isLive) {
    for (let i = sortedEvents.length - 1; i >= 0; i--) {
      const ev = sortedEvents[i];
      if (ev.type === 'message.completed' || ev.type === 'agent.message') {
        const p = ev.payload ?? {};
        const role = asText(p.role, 'assistant');
        const calls = Array.isArray(p.calls) ? p.calls : [];
        if (role === 'assistant' && calls.length === 0) {
          finalAssistantMessageSeq = ev.seq || i + 1;
          break;
        }
      }
    }
  }

  // 1. Pre-index tool call metadata from message.completed.calls, tool/command events, and approvals
  const callMetaById = new Map<string, { name?: string; command?: string; path?: string; writeText?: string }>();
  for (const appr of approvals) {
    if (!appr.callId) continue;
    const action = appr.action ?? {};
    const path = typeof action.path === 'string' ? action.path : undefined;
    const writeText = typeof action.text === 'string' ? action.text : typeof action.content === 'string' ? action.content : undefined;
    callMetaById.set(appr.callId, {
      name: appr.tool,
      command: fmtActionCommand(appr.tool, action),
      path,
      writeText,
    });
  }
  for (const ev of sortedEvents) {
    const payload = ev.payload ?? {};
    if (ev.type === 'message.completed' && Array.isArray(payload.calls)) {
      for (const rawCall of payload.calls) {
        if (!rawCall || typeof rawCall !== 'object') continue;
        const call = rawCall as Record<string, unknown>;
        const cid = asText(call.id).trim();
        if (!cid) continue;
        const name = asText(call.name).trim();
        const args = call.arguments && typeof call.arguments === 'object' ? (call.arguments as Record<string, unknown>) : null;
        const path = args ? (asText(args.path) || asText(args.filePath) || undefined) : undefined;
        const writeText = args ? (asText(args.content) || asText(args.text) || undefined) : undefined;
        const cmd = extractCommandFromArgs(name, args);
        const prev = callMetaById.get(cid);
        callMetaById.set(cid, {
          name: name || prev?.name,
          command: cmd || prev?.command,
          path: path || prev?.path,
          writeText: writeText || prev?.writeText,
        });
      }
    }
    if (ev.type === 'tool.requested' || ev.type === 'tool.started' || ev.type === 'command.started') {
      const cid = asText(payload.callId).trim();
      if (!cid) continue;
      const name = asText(payload.name) || asText(payload.tool);
      const path = asText(payload.path) || asText(payload.filePath) || undefined;
      const cmd = asText(payload.command)
        || asText(payload.cmd)
        || (Array.isArray(payload.argv) ? payload.argv.map(String).join(' ') : '')
        || (typeof payload.arguments === 'string' ? payload.arguments : '');
      const prev = callMetaById.get(cid);
      callMetaById.set(cid, {
        name: name || prev?.name,
        command: cmd || prev?.command,
        path: path || prev?.path,
        writeText: prev?.writeText,
      });
    }
  }

  // 2. Build SINGLE unified Plan Summary (seeded from task.plan/assignments, dynamically updated by events)
  const planNodeMap = new Map<string, UnifiedPlanNode>();
  let planTitle: string | undefined;
  let planStatus: UnifiedPlanSummary['status'] = 'queued';
  const planComplexity = plan?.complexity;
  const planRisk = plan?.risk;

  if (plan?.nodes?.length) {
    for (const node of plan.nodes) {
      const asgn = assignmentByKey.get(node.key);
      const linkedWorker = (asgn?.workerId ? workerById.get(asgn.workerId) : undefined)
        ?? workers.find((w) => w.assignmentId === asgn?.id || w.assignmentId === node.key);
      planNodeMap.set(node.key, {
        nodeId: node.key,
        displayName: getWorkerDisplayName(linkedWorker, { assignment: asgn }) !== 'Agent'
          ? (node.workerName || linkedWorker?.workerName || node.key)
          : node.key,
        displayRole: node.workerRole || linkedWorker?.workerRole || node.role,
        objective: node.objective,
        activityLabel: linkedWorker?.activityLabel || node.objective,
        status: mapAssignmentStatus(asgn?.status),
        workerId: linkedWorker?.id ?? asgn?.workerId,
      });
    }
  }

  // Update plan nodes from chronological events
  for (const ev of sortedEvents) {
    const payload = ev.payload ?? {};
    if (ev.type === 'plan.created' || ev.type === 'plan.completed' || ev.type === 'plan.failed' || ev.type === 'plan.cancelled') {
      if (typeof payload.title === 'string' && payload.title.trim()) planTitle = payload.title.trim();
      if (ev.type === 'plan.completed') planStatus = 'completed';
      else if (ev.type === 'plan.failed') planStatus = 'failed';
      else if (ev.type === 'plan.cancelled') planStatus = 'cancelled';
      else if (planStatus === 'queued') planStatus = 'running';

      if (Array.isArray(payload.workers)) {
        for (const rawW of payload.workers) {
          if (!rawW || typeof rawW !== 'object') continue;
          const entry = rawW as Record<string, unknown>;
          const nodeId = asText(entry.nodeId).trim();
          if (!nodeId) continue;
          const prev = planNodeMap.get(nodeId);
          const resolvedWorker = resolveWorkerForPayload(entry, workers);
          const displayName = asText(entry.workerName).trim() || prev?.displayName || getWorkerDisplayName(resolvedWorker, { payload: entry });
          const displayRole = asText(entry.workerRole).trim() || prev?.displayRole || getWorkerDisplayRole(resolvedWorker, { payload: entry });
          const activityLabel = asText(entry.activityLabel).trim() || prev?.activityLabel || displayName;
          const status: UnifiedPlanNode['status'] =
            ev.type === 'plan.completed'
              ? 'done'
              : ev.type === 'plan.failed'
                ? (prev?.status === 'done' ? 'done' : 'failed')
                : ev.type === 'plan.cancelled'
                  ? (prev?.status === 'done' ? 'done' : 'cancelled')
                  : prev?.status ?? 'queued';
          planNodeMap.set(nodeId, {
            nodeId,
            displayName,
            displayRole,
            objective: prev?.objective || displayName,
            activityLabel,
            status,
            workerId: asText(entry.workerId).trim() || resolvedWorker?.id || prev?.workerId,
          });
        }
      }
      continue;
    }

    if (ev.type.startsWith('node.') || ev.type.startsWith('worker.')) {
      const nodeId = asText(payload.nodeId).trim();
      if (!nodeId) continue;
      const prev = planNodeMap.get(nodeId);
      const resolvedWorker = resolveWorkerForPayload(payload, workers);
      const nextStatus: UnifiedPlanNode['status'] =
        ev.type === 'node.succeeded' || (ev.type === 'worker.completed' && payload.status !== 'failed' && payload.status !== 'cancelled')
          ? 'done'
          : ev.type === 'node.failed' || ev.type === 'worker.rejected' || (ev.type === 'worker.completed' && (payload.status === 'failed' || payload.status === 'cancelled'))
            ? 'failed'
            : ev.type === 'node.awaiting_approval'
              ? 'awaiting_approval'
              : ev.type === 'node.started' || ev.type === 'worker.started' || ev.type === 'worker.resumed'
                ? 'running'
                : ev.type === 'node.queued' || ev.type === 'node.rework'
                  ? 'queued'
                  : prev?.status ?? 'pending';
      const displayName = asText(payload.workerName).trim()
        || prev?.displayName
        || getWorkerDisplayName(resolvedWorker, { payload });
      const displayRole = asText(payload.workerRole).trim()
        || prev?.displayRole
        || getWorkerDisplayRole(resolvedWorker, { payload });
      const activityLabel = getWorkerActivityLabel(resolvedWorker, payload) || prev?.activityLabel || displayName;
      planNodeMap.set(nodeId, {
        nodeId,
        displayName,
        displayRole,
        objective: prev?.objective || displayName,
        activityLabel,
        status: nextStatus,
        workerId: asText(payload.workerId).trim() || resolvedWorker?.id || prev?.workerId,
      });
    }
  }

  let planSummary: UnifiedPlanSummary | null = null;
  if (!subagentMode && planNodeMap.size > 0) {
    const nodes = [...planNodeMap.values()];
    if (planStatus === 'queued' || planStatus === 'running') {
      if (nodes.every((n) => n.status === 'done')) planStatus = 'completed';
      else if (nodes.some((n) => n.status === 'running' || n.status === 'awaiting_approval' || n.status === 'queued')) planStatus = 'running';
      else if (nodes.some((n) => n.status === 'failed')) planStatus = 'failed';
    }
    planSummary = {
      title: planTitle,
      complexity: planComplexity,
      risk: planRisk,
      status: planStatus,
      nodes,
    };
  }

  // 3. Converge runtime events into ONE deduplicated list
  const items: UnifiedActivityItem[] = [];
  let orderCounter = 0;
  const nextOrder = () => ++orderCounter;

  const commandByCallId = new Map<string, Extract<UnifiedActivityItem, { kind: 'command' }>>();
  const fileByCallId = new Map<string, Extract<UnifiedActivityItem, { kind: 'file' }>>();
  const fileByPathKey = new Map<string, Extract<UnifiedActivityItem, { kind: 'file' }>>();
  const workerStartByKey = new Map<string, Extract<UnifiedActivityItem, { kind: 'worker' }>>();
  const workerDoneByKey = new Map<string, Extract<UnifiedActivityItem, { kind: 'worker' }>>();
  const approvalByIdMap = new Map<string, Extract<UnifiedActivityItem, { kind: 'approval' }>>();
  const seenCommentaryTexts = new Set<string>();
  let hasCompaction = false;

  const canonicalWorkerKeyFor = (payload: Record<string, unknown>, worker?: Worker): string => {
    const nodeId = asText(payload.nodeId).trim();
    if (nodeId) return `node:${nodeId}`;
    if (worker?.assignmentId) return `node:${worker.assignmentId}`;
    if (worker?.id) return `worker:${worker.id}`;
    const resolvedId = resolveWorkerIdFromPayload(payload);
    return resolvedId ? `worker:${resolvedId}` : '';
  };

  for (let idx = 0; idx < sortedEvents.length; idx++) {
    const ev = sortedEvents[idx];
    const payload = ev.payload ?? {};
    const worker = resolveWorkerForPayload(payload, workers);
    const asgn = worker?.assignmentId
      ? (assignmentById.get(worker.assignmentId) ?? assignmentByKey.get(worker.assignmentId))
      : undefined;
    const workerLabel = getWorkerDisplayName(worker, { payload, assignment: asgn });
    const workerRole = getWorkerDisplayRole(worker, { payload, assignment: asgn });
    const seq = ev.seq || 0;
    const timestamp = ev.timestamp || startedAt || 0;

    // Context compaction
    if (ev.type.includes('compact')) {
      if (!hasCompaction) {
        hasCompaction = true;
        items.push({ kind: 'compaction', id: `compact-${seq || idx}`, seq, timestamp, order: nextOrder() });
      }
      continue;
    }

    // Plan-level / node queue / acceptance events are already reflected in planSummary
    if (
      ev.type === 'session.created'
      || ev.type === 'session.updated'
      || ev.type === 'turn.started'
      || ev.type === 'turn.step'
      || ev.type === 'turn.completed'
      || ev.type === 'message.started'
      || ev.type === 'message.delta'
      || ev.type === 'plan.created'
      || ev.type === 'plan.revised'
      || ev.type === 'plan.completed'
      || ev.type === 'plan.cancelled'
      || ev.type === 'node.queued'
      || ev.type === 'node.acceptance'
      || ev.type === 'node.rework'
    ) {
      continue;
    }

    // Errors
    if (ev.type === 'turn.failed' || ev.type === 'message.failed' || ev.type === 'plan.failed') {
      const msg = asText(payload.message) || asText(payload.error) || asText(payload.reason) || '执行失败';
      items.push({
        kind: 'error',
        id: `err-${ev.type}-${seq || idx}`,
        seq,
        timestamp,
        order: nextOrder(),
        title: ev.type === 'plan.failed' ? '计划执行失败' : '执行失败',
        message: msg,
        worker,
        workerLabel,
        eventType: ev.type,
      });
      continue;
    }

    // Approvals (deduplicated by approvalId; suppressed later if still pending and handled by external ApprovalGateCard)
    if (
      ev.type === 'approval.requested'
      || ev.type === 'approval.required'
      || ev.type === 'node.awaiting_approval'
      || ev.type === 'approval.decided'
      || ev.type === 'approval.resolved'
    ) {
      const approvalId = extractApprovalId(payload) || `appr-seq-${seq || idx}`;
      const nestedAppr = payload.approval && typeof payload.approval === 'object'
        ? (payload.approval as Record<string, unknown>)
        : null;
      const existingApprObj = approvalById.get(approvalId);
      const tool = asText(payload.tool)
        || asText(nestedAppr?.tool)
        || existingApprObj?.tool
        || '工具调用';
      const argsObj = nestedAppr?.arguments && typeof nestedAppr.arguments === 'object'
        ? (nestedAppr.arguments as Record<string, unknown>)
        : existingApprObj?.action;
      const command = argsObj ? fmtActionCommand(tool, argsObj) : undefined;
      const reason = asText(payload.reason) || asText(nestedAppr?.reason) || undefined;

      const isDecided = ev.type === 'approval.decided' || ev.type === 'approval.resolved';
      const decision = asText(payload.decision).toLowerCase();
      const nextStatus: 'pending' | 'approved' | 'denied' = isDecided
        ? (decision === 'allow' || decision === 'approve' ? 'approved' : 'denied')
        : existingApprObj && existingApprObj.status !== 'pending'
          ? (existingApprObj.status === 'approve' || existingApprObj.status === 'consumed' ? 'approved' : 'denied')
          : 'pending';

      const prev = approvalByIdMap.get(approvalId);
      if (prev) {
        if (isDecided || prev.status === 'pending') prev.status = nextStatus;
        if (tool && prev.tool === '工具调用') prev.tool = tool;
        if (command && !prev.command) prev.command = command;
        if (reason && !prev.reason) prev.reason = reason;
        if (worker && !prev.worker) {
          prev.worker = worker;
          prev.workerLabel = workerLabel;
        }
        prev.eventType = ev.type;
      } else {
        const entry: Extract<UnifiedActivityItem, { kind: 'approval' }> = {
          kind: 'approval',
          id: `approval-${approvalId}`,
          seq,
          timestamp,
          order: nextOrder(),
          approvalId,
          tool,
          command,
          status: nextStatus,
          reason,
          worker,
          workerLabel,
          eventType: ev.type,
        };
        approvalByIdMap.set(approvalId, entry);
      }
      continue;
    }

    // Worker / Node lifecycle (deduplicated by canonical workerId / nodeId)
    if (
      ev.type === 'worker.started'
      || ev.type === 'node.started'
      || ev.type === 'worker.resumed'
      || ev.type === 'worker.completed'
      || ev.type === 'worker.rejected'
      || ev.type === 'node.succeeded'
      || ev.type === 'node.failed'
    ) {
      if (subagentMode) continue;
      const wKey = canonicalWorkerKeyFor(payload, worker);
      if (!wKey || workerRole === 'router') continue;

      const activityLabel = getWorkerActivityLabel(worker, payload);
      const isStart = ev.type === 'worker.started' || ev.type === 'node.started';
      const isResumed = ev.type === 'worker.resumed';

      if (isStart) {
        const existing = workerStartByKey.get(wKey);
        if (existing) {
          if (worker) existing.worker = worker;
          if (workerLabel !== 'Agent') existing.label = workerLabel;
          if (workerRole) existing.role = workerRole;
          if (activityLabel) existing.activityLabel = activityLabel;
        } else {
          const entry: Extract<UnifiedActivityItem, { kind: 'worker' }> = {
            kind: 'worker',
            id: `worker-start-${wKey}`,
            seq,
            timestamp,
            order: nextOrder(),
            phase: 'started',
            workerKey: wKey,
            worker,
            label: workerLabel,
            role: workerRole,
            activityLabel,
            eventType: ev.type,
          };
          workerStartByKey.set(wKey, entry);
          items.push(entry);
        }
        continue;
      }

      if (isResumed) {
        items.push({
          kind: 'worker',
          id: `worker-resumed-${wKey}-${seq || idx}`,
          seq,
          timestamp,
          order: nextOrder(),
          phase: 'resumed',
          workerKey: wKey,
          worker,
          label: workerLabel,
          role: workerRole,
          activityLabel: activityLabel || '已恢复执行',
          eventType: ev.type,
        });
        continue;
      }

      const failed =
        ev.type === 'node.failed'
        || ev.type === 'worker.rejected'
        || payload.status === 'failed'
        || payload.status === 'cancelled';
      const existingDone = workerDoneByKey.get(wKey);
      if (existingDone) {
        if (worker) existingDone.worker = worker;
        if (workerLabel !== 'Agent') existingDone.label = workerLabel;
        if (failed) existingDone.phase = 'failed';
        if (activityLabel) existingDone.activityLabel = activityLabel;
      } else {
        const entry: Extract<UnifiedActivityItem, { kind: 'worker' }> = {
          kind: 'worker',
          id: `worker-done-${wKey}`,
          seq,
          timestamp,
          order: nextOrder(),
          phase: failed ? 'failed' : 'completed',
          workerKey: wKey,
          worker,
          label: workerLabel,
          role: workerRole,
          activityLabel,
          eventType: ev.type,
        };
        workerDoneByKey.set(wKey, entry);
        items.push(entry);
      }
      continue;
    }

    // Explicit file events
    if (ev.type === 'file.read' || ev.type === 'file.write' || ev.type === 'file.patch') {
      const rawPath = asText(payload.path) || asText(payload.filePath);
      if (!rawPath) continue;
      const normPath = normalizeFilePath(rawPath);
      const operation: 'read' | 'write' | 'patch' =
        ev.type === 'file.read' ? 'read' : ev.type === 'file.patch' ? 'patch' : 'write';
      const callId = asText(payload.callId).trim() || undefined;
      const pathKey = `${operation === 'read' ? 'read' : 'write'}:${normPath}`;
      const existing = (callId ? fileByCallId.get(callId) : undefined) ?? fileByPathKey.get(pathKey);
      const added = typeof payload.added === 'number' ? payload.added : undefined;
      const deleted = typeof payload.deleted === 'number' ? payload.deleted : undefined;
      const summary = asText(payload.summary) || undefined;
      if (existing) {
        if (added !== undefined) existing.added = added;
        if (deleted !== undefined) existing.deleted = deleted;
        if (summary) existing.summary = summary;
        existing.status = payload.isError || payload.status === 'failed' ? 'failed' : 'completed';
      } else {
        const base = normPath.split('/').pop() || normPath;
        const entry: Extract<UnifiedActivityItem, { kind: 'file' }> = {
          kind: 'file',
          id: `file-${callId || `${operation}-${normPath}-${seq || idx}`}`,
          seq,
          timestamp,
          order: nextOrder(),
          callId,
          operation,
          path: normPath,
          base,
          added,
          deleted,
          status: payload.isError || payload.status === 'failed' ? 'failed' : 'completed',
          summary,
          worker,
          workerLabel,
          eventType: ev.type,
        };
        if (callId) fileByCallId.set(callId, entry);
        fileByPathKey.set(pathKey, entry);
        items.push(entry);
      }
      continue;
    }

    // Tool & Command events (deduplicated by callId)
    if (
      ev.type === 'tool.requested'
      || ev.type === 'tool.started'
      || ev.type === 'tool.completed'
      || ev.type === 'command.started'
      || ev.type === 'command.output'
      || ev.type === 'command.completed'
    ) {
      const callId = asText(payload.callId).trim() || undefined;
      const meta = callId ? callMetaById.get(callId) : undefined;
      const toolName = asText(payload.name) || asText(payload.tool) || meta?.name || 'command';
      const parsedResult = ev.type === 'tool.completed' || ev.type === 'command.completed'
        ? parseToolResultContent(payload.content ?? payload.output)
        : {};
      const rawPath = asText(payload.path) || asText(payload.filePath) || meta?.path || parsedResult.path || '';
      const normPath = rawPath ? normalizeFilePath(rawPath) : '';

      // Route file tools into File items so file edits show path & change summary cleanly
      if (normPath && (isReadTool(toolName) || isWriteTool(toolName))) {
        const operation: 'read' | 'write' | 'patch' = isReadTool(toolName)
          ? 'read'
          : toolName.toLowerCase().includes('patch')
            ? 'patch'
            : 'write';
        const pathKey = `${operation === 'read' ? 'read' : 'write'}:${normPath}`;
        const existing = (callId ? fileByCallId.get(callId) : undefined) ?? fileByPathKey.get(pathKey);
        const isDone = ev.type === 'tool.completed' || ev.type === 'command.completed';
        const isFailed = Boolean(
          payload.isError
          || payload.status === 'failed'
          || (typeof payload.exitCode === 'number' && payload.exitCode !== 0)
          || (typeof parsedResult.exitCode === 'number' && parsedResult.exitCode !== 0),
        );

        let added = typeof payload.added === 'number' ? payload.added : parsedResult.added;
        let deleted = typeof payload.deleted === 'number' ? payload.deleted : parsedResult.deleted;
        let diffLines: DiffLine[] | undefined;
        let afterText: string | undefined;
        let isCreated: boolean | undefined;
        let previewLines: string[] | undefined;

        if (operation !== 'read') {
          const beforeRaw = taskFiles?.[normPath] ?? artifactFiles?.[normPath];
          const beforeText = beforeRaw ? decodeBase64Utf8(beforeRaw) : '';
          const candidateAfter = meta?.writeText ?? (artifactFiles?.[normPath] ? decodeBase64Utf8(artifactFiles[normPath]) : undefined);
          if (candidateAfter !== undefined) {
            afterText = candidateAfter;
            const diff = computeDiff(beforeText, candidateAfter);
            diffLines = diff.lines;
            if (added === undefined) added = diff.added;
            if (deleted === undefined) deleted = diff.deleted;
            isCreated = !beforeText.trim() && Boolean(candidateAfter.trim());
          }
        } else if (parsedResult.output) {
          previewLines = parsedResult.output.replace(/\r\n/g, '\n').split('\n').slice(0, 60);
        }

        if (existing) {
          if (isDone) existing.status = isFailed ? 'failed' : 'completed';
          if (added !== undefined) existing.added = added;
          if (deleted !== undefined) existing.deleted = deleted;
          if (diffLines) existing.diffLines = diffLines;
          if (afterText !== undefined) existing.afterText = afterText;
          if (isCreated !== undefined) existing.isCreated = isCreated;
          if (previewLines) existing.previewLines = previewLines;
          if (parsedResult.error) existing.errorNote = parsedResult.error;
          if (parsedResult.summary) existing.summary = parsedResult.summary;
          existing.eventType = ev.type;
        } else {
          const base = normPath.split('/').pop() || normPath;
          const entry: Extract<UnifiedActivityItem, { kind: 'file' }> = {
            kind: 'file',
            id: `file-${callId || `${operation}-${normPath}-${seq || idx}`}`,
            seq,
            timestamp,
            order: nextOrder(),
            callId,
            operation,
            path: normPath,
            base,
            added,
            deleted,
            isCreated,
            status: isDone ? (isFailed ? 'failed' : 'completed') : 'running',
            summary: parsedResult.summary,
            errorNote: parsedResult.error,
            afterText,
            diffLines,
            previewLines,
            worker,
            workerLabel,
            eventType: ev.type,
          };
          if (callId) fileByCallId.set(callId, entry);
          fileByPathKey.set(pathKey, entry);
          items.push(entry);
        }
        continue;
      }

      // Command / generic tool item (merged by callId)
      const cmdText =
        asText(payload.command)
        || asText(payload.cmd)
        || (Array.isArray(payload.argv) ? payload.argv.map(String).join(' ') : '')
        || meta?.command
        || (normPath ? `${toolName} ${normPath}` : toolName);
      const existing = callId ? commandByCallId.get(callId) : undefined;

      if (ev.type === 'command.output') {
        const chunk = asText(payload.chunk) || asText(payload.output) || asText(payload.stdout) || asText(payload.stderr);
        if (existing && chunk) {
          existing.output = existing.output ? `${existing.output}${chunk}` : chunk;
        }
        continue;
      }

      const isDone = ev.type === 'tool.completed' || ev.type === 'command.completed';
      const exitCode = typeof payload.exitCode === 'number' ? payload.exitCode : parsedResult.exitCode;
      const isFailed = Boolean(
        payload.isError
        || payload.status === 'failed'
        || (typeof exitCode === 'number' && exitCode !== 0),
      );
      const outputText = [
        asText(payload.stdout),
        asText(payload.stderr),
      ].filter(Boolean).join('\n') || parsedResult.output || undefined;
      const errorText = asText(payload.error) || parsedResult.error || undefined;
      const rawDuration = Number(payload.durationMs ?? payload.elapsedMs ?? 0);

      if (existing) {
        if (cmdText && existing.command === existing.toolName) existing.command = cmdText;
        if (normPath && !existing.filePath) existing.filePath = normPath;
        if (outputText) existing.output = outputText;
        if (errorText) existing.error = errorText;
        if (exitCode !== undefined) existing.exitCode = exitCode;
        if (isDone) {
          existing.status = isFailed ? 'failed' : 'completed';
          existing.eventType = ev.type;
          if (Number.isFinite(rawDuration) && rawDuration > 0) {
            existing.durationMs = rawDuration;
          } else if (existing.startedAt && timestamp > existing.startedAt) {
            existing.durationMs = timestamp - existing.startedAt;
          }
        }
      } else {
        const entry: Extract<UnifiedActivityItem, { kind: 'command' }> = {
          kind: 'command',
          id: `cmd-${callId || `${seq || idx}`}`,
          seq,
          timestamp,
          order: nextOrder(),
          callId,
          toolName,
          command: cmdText,
          output: outputText,
          error: errorText,
          exitCode,
          status: isDone ? (isFailed ? 'failed' : 'completed') : 'running',
          startedAt: timestamp,
          durationMs: Number.isFinite(rawDuration) && rawDuration > 0 ? rawDuration : undefined,
          worker,
          workerLabel,
          eventType: ev.type,
          filePath: normPath || undefined,
        };
        if (callId) commandByCallId.set(callId, entry);
        items.push(entry);
      }
      continue;
    }

    // Assistant messages: NEVER duplicate the final assistant reply!
    if (ev.type === 'message.completed' || ev.type === 'agent.message') {
      const role = asText(payload.role, 'assistant');
      if (role === 'user') continue;
      const content = (asText(payload.content) || asText(payload.message)).trim();
      if (!content || isRawJsonPayload(content)) continue;
      if (finalProseSet.has(content)) continue;
      const evMarker = ev.seq || idx + 1;
      if (finalAssistantMessageSeq !== null && evMarker === finalAssistantMessageSeq) continue;
      // Only keep short/intermediate commentary that hasn't already been emitted
      if (seenCommentaryTexts.has(content)) continue;
      seenCommentaryTexts.add(content);
      items.push({
        kind: 'commentary',
        id: `msg-${seq || idx}`,
        seq,
        timestamp,
        order: nextOrder(),
        role: workerLabel,
        text: content,
      });
    }
  }

  // Push deduplicated approval rows (ONLY if resolved OR not already rendered by external ApprovalGateCard)
  for (const apprItem of approvalByIdMap.values()) {
    if (apprItem.status === 'pending' && pendingExternalApprovalIds.has(apprItem.approvalId)) {
      continue;
    }
    items.push(apprItem);
  }

  // 4. Merge legacy Evidence / Workers / Sessions commentary ONLY where not already covered by runtime events
  const seenImagePaths = new Set<string>();
  const combinedImagePool: Record<string, string> = {
    ...(taskFiles ?? {}),
    ...(artifactFiles ?? {}),
  };

  // Helper to estimate a fallback timestamp for legacy items without seq
  const legacyBaseTs = startedAt || (sortedEvents[0]?.timestamp ?? 0);
  let legacyOffset = 1;
  const nextLegacyTs = () => legacyBaseTs + legacyOffset++;

  const hasRuntimeWorkerEvents = workerStartByKey.size > 0 || workerDoneByKey.size > 0;
  const collabWorkers = subagentMode
    ? []
    : workers.filter((w) => w.role !== 'Planner' && w.role !== 'Reviewer');

  const legacyStartedWorkers = new Set<string>();
  const legacyDoneWorkers = new Set<string>();

  const isWorkerCoveredByRuntime = (w: Worker): boolean => {
    if (workerStartByKey.has(`worker:${w.id}`)) return true;
    if (w.assignmentId && workerStartByKey.has(`node:${w.assignmentId}`)) return true;
    return false;
  };

  const isWorkerDoneCoveredByRuntime = (w: Worker): boolean => {
    if (workerDoneByKey.has(`worker:${w.id}`)) return true;
    if (w.assignmentId && workerDoneByKey.has(`node:${w.assignmentId}`)) return true;
    return false;
  };

  // Emit initial legacy subagent start line ONLY if runtime events didn't already emit worker starts
  if (!hasRuntimeWorkerEvents && collabWorkers.length > 0) {
    const firstGroup = collabWorkers.slice(0, 2);
    for (const w of firstGroup) legacyStartedWorkers.add(w.id);
    const groupEntries = firstGroup.map((w) => ({
      worker: w,
      label: getWorkerDisplayName(w, { assignment: w.assignmentId ? assignmentById.get(w.assignmentId) : undefined }),
    }));
    items.push({
      kind: 'worker',
      id: `sa-start-${firstGroup.map((w) => w.id).join('-')}`,
      seq: 0,
      timestamp: nextLegacyTs(),
      order: nextOrder(),
      phase: 'started',
      workerKey: `worker:${firstGroup[0].id}`,
      worker: firstGroup[0],
      workers: groupEntries,
      label: groupEntries.map((x) => x.label).join(' 和 '),
      role: getWorkerDisplayRole(firstGroup[0]),
      eventType: 'worker.started',
    });
  }

  // Merge legacy Evidence items (deduplicating against runtime events by callId, filePath, and command signature)
  const imageBatch: ActivityImageItem[] = [];
  const flushImageBatch = () => {
    if (!imageBatch.length) return;
    items.push({
      kind: 'image-view',
      id: `img-view-${imageBatch[0].id}`,
      seq: 0,
      timestamp: nextLegacyTs(),
      order: nextOrder(),
      images: [...imageBatch],
    });
    imageBatch.length = 0;
  };

  for (const ev of evidence) {
    const appr = ev.approvalId ? approvalById.get(ev.approvalId) : undefined;
    const worker = workerById.get(ev.workerId);
    const asgn = worker?.assignmentId ? assignmentById.get(worker.assignmentId) : undefined;
    const workerLabel = getWorkerDisplayName(worker, { assignment: asgn });
    const failed = (typeof ev.exitCode === 'number' && ev.exitCode !== 0) || ev.status === 'failed';

    const apprPath = appr && typeof appr.action?.path === 'string' ? appr.action.path : '';
    const targetPath = ev.path || apprPath;

    // Image evidence
    if (targetPath && (ev.tool === 'view_image' || ((ev.tool === 'read_file' || ev.tool === 'mcp') && isImagePath(targetPath)))) {
      const norm = normalizeFilePath(targetPath);
      if (!seenImagePaths.has(norm)) {
        seenImagePaths.add(norm);
        const base = norm.split('/').pop() || norm;
        imageBatch.push({
          id: `ev-img-${ev.id}`,
          path: norm,
          name: base,
          rawBase64: combinedImagePool[targetPath] ?? combinedImagePool[base] ?? ev.stdout,
        });
      }
      continue;
    }
    flushImageBatch();

    if (!subagentMode && worker && worker.role !== 'Planner' && worker.role !== 'Reviewer'
      && !legacyStartedWorkers.has(worker.id) && !isWorkerCoveredByRuntime(worker)) {
      legacyStartedWorkers.add(worker.id);
      items.push({
        kind: 'worker',
        id: `sa-start-${worker.id}`,
        seq: 0,
        timestamp: nextLegacyTs(),
        order: nextOrder(),
        phase: 'started',
        workerKey: `worker:${worker.id}`,
        worker,
        workers: [{ worker, label: workerLabel }],
        label: workerLabel,
        role: getWorkerDisplayRole(worker, { assignment: asgn }),
        eventType: 'worker.started',
      });
    }

    const callId = appr?.callId;

    // File read evidence
    if (ev.tool === 'read_file' && targetPath) {
      const norm = normalizeFilePath(targetPath);
      const pathKey = `read:${norm}`;
      const existing = (callId ? fileByCallId.get(callId) : undefined) ?? fileByPathKey.get(pathKey);
      const rawB64 = artifactFiles?.[targetPath] ?? taskFiles?.[targetPath] ?? artifactFiles?.[norm] ?? taskFiles?.[norm];
      const previewText = rawB64 ? decodeBase64Utf8(rawB64) : ev.stdout || '';
      const previewLines = previewText ? previewText.replace(/\r\n/g, '\n').split('\n').slice(0, 60) : [];
      if (existing) {
        if (previewLines.length && !existing.previewLines?.length) existing.previewLines = previewLines;
        existing.status = failed ? 'failed' : 'completed';
      } else {
        const entry: Extract<UnifiedActivityItem, { kind: 'file' }> = {
          kind: 'file',
          id: `ev-read-${ev.id}`,
          seq: 0,
          timestamp: nextLegacyTs(),
          order: nextOrder(),
          callId,
          operation: 'read',
          path: norm,
          base: norm.split('/').pop() || norm,
          status: failed ? 'failed' : 'completed',
          previewLines,
          worker,
          workerLabel,
          eventType: 'file.read',
        };
        fileByPathKey.set(pathKey, entry);
        items.push(entry);
      }
      continue;
    }

    // Command execution (shell / pty / git / mcp) — even if it also produced file changes!
    const isCommandTool = ev.tool !== 'write_file' && ev.tool !== 'read_file';
    if (isCommandTool) {
      const commandText = appr
        ? fmtActionCommand(appr.tool, appr.action)
        : ev.path
          ? `${ev.tool} ${ev.path}`
          : ev.tool;
      const combinedOutput = [ev.stdout, ev.stderr].filter(Boolean).join('\n') || undefined;
      const existingCmd =
        (callId ? commandByCallId.get(callId) : undefined)
        ?? [...commandByCallId.values()].find(
          (c) => c.command === commandText && (!worker || !c.worker || c.worker.id === worker.id),
        );
      if (existingCmd) {
        if (combinedOutput && !existingCmd.output) existingCmd.output = combinedOutput;
        if (ev.exitCode !== undefined) existingCmd.exitCode = ev.exitCode;
        existingCmd.status = failed ? 'failed' : 'completed';
      } else {
        const entry: Extract<UnifiedActivityItem, { kind: 'command' }> = {
          kind: 'command',
          id: `ev-cmd-${ev.id}`,
          seq: 0,
          timestamp: nextLegacyTs(),
          order: nextOrder(),
          callId,
          toolName: ev.tool,
          command: commandText,
          output: combinedOutput,
          exitCode: ev.exitCode,
          status: failed ? 'failed' : ev.status === 'executing' ? 'running' : 'completed',
          worker,
          workerLabel,
          eventType: 'command.completed',
          filePath: ev.path ? normalizeFilePath(ev.path) : undefined,
        };
        if (callId) commandByCallId.set(callId, entry);
        items.push(entry);
      }
    }

    // File write / change deltas (from write_file OR side-effect changes on shell evidence)
    if (ev.tool === 'write_file' || (ev.changes && ev.changes.length > 0)) {
      const errorNote = failed
        ? [ev.stderr, ev.stdout].filter(Boolean).join(' ').trim() || '写入未执行完成（沙箱容器不可用或审批被拒绝）'
        : undefined;
      const apprWriteText = appr && typeof appr.action?.text === 'string' ? appr.action.text : undefined;

      const fileEntries = ev.changes?.length
        ? ev.changes.map((c) => {
            const beforeText = decodeBase64Utf8(c.before);
            const afterText = decodeBase64Utf8(c.after);
            const { lines, added, deleted } = computeDiff(beforeText, afterText);
            return {
              path: normalizeFilePath(c.path),
              added,
              deleted,
              isCreated: !beforeText.trim(),
              afterText,
              lines,
            };
          })
        : targetPath
          ? (() => {
              const norm = normalizeFilePath(targetPath);
              const beforeRaw = taskFiles?.[targetPath] ?? artifactFiles?.[targetPath] ?? taskFiles?.[norm] ?? artifactFiles?.[norm];
              const beforeText = beforeRaw ? decodeBase64Utf8(beforeRaw) : '';
              const afterText = apprWriteText ?? ev.stdout ?? beforeText;
              const { lines, added, deleted } = computeDiff(beforeText, afterText);
              return [{
                path: norm,
                added,
                deleted,
                isCreated: !beforeText.trim() && Boolean(afterText.trim()),
                afterText,
                lines,
              }];
            })()
          : [];

      for (const fi of fileEntries) {
        const pathKey = `write:${fi.path}`;
        const existing = (callId ? fileByCallId.get(callId) : undefined) ?? fileByPathKey.get(pathKey);
        if (existing) {
          existing.added = fi.added;
          existing.deleted = fi.deleted;
          existing.isCreated = fi.isCreated;
          existing.afterText = fi.afterText;
          existing.diffLines = fi.lines;
          existing.errorNote = errorNote;
          existing.status = failed ? 'failed' : 'completed';
        } else {
          const entry: Extract<UnifiedActivityItem, { kind: 'file' }> = {
            kind: 'file',
            id: `ev-file-${ev.id}-${fi.path}`,
            seq: 0,
            timestamp: nextLegacyTs(),
            order: nextOrder(),
            callId,
            operation: 'write',
            path: fi.path,
            base: fi.path.split('/').pop() || fi.path,
            added: fi.added,
            deleted: fi.deleted,
            isCreated: fi.isCreated,
            status: failed ? 'failed' : 'completed',
            errorNote,
            afterText: fi.afterText,
            diffLines: fi.lines,
            worker,
            workerLabel,
            eventType: 'file.write',
          };
          fileByPathKey.set(pathKey, entry);
          items.push(entry);
        }
      }
    }
  }
  flushImageBatch();

  // Attached input images not already seen via evidence
  if (!subagentMode && taskFiles) {
    const attachedImgs: ActivityImageItem[] = [];
    for (const [p, b64] of Object.entries(taskFiles)) {
      const norm = normalizeFilePath(p);
      if (!isImagePath(norm) || seenImagePaths.has(norm)) continue;
      attachedImgs.push({
        id: `task-img-${norm}`,
        path: norm,
        name: norm.split('/').pop() || norm,
        rawBase64: b64,
      });
    }
    if (attachedImgs.length > 0) {
      items.push({
        kind: 'image-view',
        id: `img-view-attached-${attachedImgs.length}`,
        seq: 0,
        timestamp: legacyBaseTs,
        order: 0,
        images: attachedImgs,
      });
    }
  }

  // Remaining legacy collab workers (only when not covered by runtime worker/node events)
  for (const w of collabWorkers) {
    if (w.status === 'waiting' || w.status === 'unknown' || (w.status === 'cancelled' && !w.attempt)) continue;
    const asgn = w.assignmentId ? assignmentById.get(w.assignmentId) : undefined;
    const label = getWorkerDisplayName(w, { assignment: asgn });
    if (!legacyStartedWorkers.has(w.id) && !isWorkerCoveredByRuntime(w)) {
      legacyStartedWorkers.add(w.id);
      items.push({
        kind: 'worker',
        id: `sa-start-${w.id}`,
        seq: 0,
        timestamp: nextLegacyTs(),
        order: nextOrder(),
        phase: 'started',
        workerKey: `worker:${w.id}`,
        worker: w,
        workers: [{ worker: w, label }],
        label,
        role: getWorkerDisplayRole(w, { assignment: asgn }),
        eventType: 'worker.started',
      });
    }
    if ((w.status === 'done' || w.status === 'failed') && !legacyDoneWorkers.has(w.id) && !isWorkerDoneCoveredByRuntime(w)) {
      legacyDoneWorkers.add(w.id);
      items.push({
        kind: 'worker',
        id: `sa-done-${w.id}`,
        seq: 0,
        timestamp: nextLegacyTs(),
        order: nextOrder(),
        phase: w.status === 'failed' ? 'failed' : 'completed',
        workerKey: `worker:${w.id}`,
        worker: w,
        label,
        role: getWorkerDisplayRole(w, { assignment: asgn }),
        eventType: 'worker.completed',
      });
    }
  }

  // Intermediate commentary from legacy sessions/histories (deduplicated against finalProseSet and runtime messages)
  for (const s of sessions) {
    if (!subagentMode && s.assignmentId === null && (s.role === 'Planner' || s.role === 'Reviewer')) {
      continue;
    }
    const list = histories[s.id] ?? [];
    for (const h of list) {
      if (h.type === 'assistant/message' && h.text?.trim()) {
        const clean = h.text.trim();
        if (finalProseSet.has(clean) || isRawJsonPayload(clean) || seenCommentaryTexts.has(clean)) continue;
        seenCommentaryTexts.add(clean);
        items.push({
          kind: 'commentary',
          id: `note-${s.id}-${h.cursor}`,
          seq: 0,
          timestamp: nextLegacyTs(),
          order: nextOrder(),
          role: s.workerName || s.workerRole || s.role,
          text: clean,
        });
      }
    }
  }

  // 5. Final unified chronological sort by (seq, timestamp, order)
  items.sort((a, b) => {
    if (a.seq > 0 && b.seq > 0 && a.seq !== b.seq) return a.seq - b.seq;
    if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
    if (a.seq !== b.seq) return a.seq - b.seq;
    return a.order - b.order;
  });

  return { planSummary, items, hasCompaction };
}
