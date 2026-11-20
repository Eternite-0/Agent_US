import type {
  BackendScheduleRecord,
  RuntimeOverviewRecord,
  SwarmRunRecord,
  ToolReceiptRecord,
} from '../types/backend';

export type ReqFn = <T>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  options?: { body?: unknown; query?: Record<string, string | number | undefined> },
) => Promise<T>;

export function createRuntimeClient(req: ReqFn) {
  return {
    getOverview(): Promise<RuntimeOverviewRecord> {
      return req('GET', '/v1/runtime/overview');
    },

    async getSessionReceipts(sessionId: string): Promise<ToolReceiptRecord[]> {
      const data = await req<{ items?: ToolReceiptRecord[] }>(
        'GET',
        `/v1/sessions/${encodeURIComponent(sessionId)}/receipts`,
      );
      return data.items ?? [];
    },

    resolveReconciliation(
      id: string,
      outcome: 'happened' | 'not_applied' | 'abort',
      note = '',
    ): Promise<Record<string, unknown>> {
      return req('POST', `/v1/reconciliations/${encodeURIComponent(id)}/resolve`, {
        body: { outcome, note },
      });
    },

    async listSwarmRuns(params?: { sessionId?: string; limit?: number }): Promise<SwarmRunRecord[]> {
      const data = await req<{ items?: SwarmRunRecord[] }>('GET', '/v1/swarm/runs', {
        query: { sessionId: params?.sessionId, limit: params?.limit },
      });
      return data.items ?? [];
    },

    async listSchedules(): Promise<BackendScheduleRecord[]> {
      const data = await req<{ items?: BackendScheduleRecord[] }>('GET', '/v1/schedules');
      return data.items ?? [];
    },

    createSchedule(input: {
      name: string;
      prompt: string;
      scheduleKind: string;
      scheduleExpr: string;
      workspaceRoot?: string;
      model?: string;
      permissionMode?: string;
      enabled?: boolean;
    }): Promise<BackendScheduleRecord> {
      return req('POST', '/v1/schedules', { body: input });
    },

    updateSchedule(
      id: string,
      patch: Partial<{
        name: string;
        prompt: string;
        scheduleKind: string;
        scheduleExpr: string;
        enabled: boolean;
      }>,
    ): Promise<BackendScheduleRecord> {
      return req('PATCH', `/v1/schedules/${encodeURIComponent(id)}`, { body: patch });
    },

    deleteSchedule(id: string): Promise<{ id: string; deleted: boolean }> {
      return req('DELETE', `/v1/schedules/${encodeURIComponent(id)}`);
    },

    runScheduleNow(id: string): Promise<{
      schedule: BackendScheduleRecord;
      session: { id: string };
      turn: { id: string };
    }> {
      return req('POST', `/v1/schedules/${encodeURIComponent(id)}/run`);
    },
  };
}
