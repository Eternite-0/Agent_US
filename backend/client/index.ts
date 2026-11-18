/** Public DTOs. The frontend does not import the Cordis or DSH packages. */
export type Status =
  | 'planning'
  | 'running'
  | 'reviewing'
  | 'completed'
  | 'failed'
  | 'paused'
  | 'cancelled';
export type RecordId = string;
export interface Entity {
  id: RecordId;
  version: number;
  projectId: RecordId | null;
  taskId: RecordId | null;
}
export interface Project extends Entity {
  name: string;
}
export interface Budget {
  maxSteps?: number;
  maxDurationSeconds?: number;
  maxCostUSD?: number;
}
export interface Submission {
  projectId: string;
  input: string;
  idempotencyKey: string;
  files?: Record<string, string>;
  budget?: Budget;
}
export interface PlanNode {
  key: string;
  role: 'Researcher' | 'Planner' | 'Coder' | 'Reviewer' | 'Tester';
  objective: string;
  acceptance: string;
  dependencies: string[];
  requiredFiles?: string[];
}
export interface Task extends Entity {
  input: string;
  status: Status;
  plan?: {
    type: string;
    complexity: 'simple' | 'medium' | 'complex';
    risk: 'low' | 'medium' | 'high';
    nodes: PlanNode[];
  };
  verdict?: { accepted: boolean; reason: string };
}
export interface Approval extends Entity {
  workerId: string;
  assignmentId: string;
  status: 'pending' | 'approve' | 'deny' | 'revoked' | 'consumed' | 'expired';
  action: Record<string, unknown>;
  tool: string;
  digest: string;
  expires: number;
}
export interface EventEnvelope {
  seq: number;
  timestamp: number;
  type: string;
  projectId: string | null;
  taskId: string | null;
  payload: Record<string, unknown>;
}
export interface Artifact extends Entity {
  text: string;
  files: Record<string, string>;
  published: boolean;
  assignmentId: string;
}
export function connect(base: string, token: string) {
  async function request<T>(path: string, body?: unknown): Promise<T> {
    const res = await fetch(new URL(`/api/v1/${path}`, base), {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const data = await res.json();
      throw Error(
        `${data.error?.code ?? res.status} (${data.error?.requestId ?? 'unknown'})`,
      );
    }
    return res.json() as Promise<T>;
  }
  return {
    projects: () => request<Project[]>('projects'),
    project: (name: string) => request<Project>('projects', { name }),
    submit: (body: Submission) => request<Task>('tasks', body),
    task: (id: string) => request<Task>('tasks/' + encodeURIComponent(id)),
    approvals: (taskId: string) =>
      request<Approval[]>('approvals?' + new URLSearchParams({ taskId })),
    decide: (approval: Approval, decision: 'approve' | 'deny') =>
      request<Approval>(
        `approvals/${encodeURIComponent(approval.id)}/decision`,
        { version: approval.version, decision },
      ),
    artifacts: (taskId: string) =>
      request<Artifact[]>('artifacts?' + new URLSearchParams({ taskId })),
    events: (taskId: string, after = 0) =>
      request<EventEnvelope[]>(
        'events?' + new URLSearchParams({ taskId, after: String(after) }),
      ),
  };
}
