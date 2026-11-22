import type {
  BackendScheduleRecord,
  ChildNotificationRecord,
  RuntimeOverviewRecord,
  ScheduleRunRecord,
  SwarmArtifactFile,
  SwarmArtifactRecord,
  SwarmMessageRecord,
  SwarmReplanRecord,
  SwarmRunRecord,
  SwarmSubmitResponse,
  ToolReceiptRecord,
} from '../types/backend';

export type ReqFn = <T>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  options?: { body?: unknown; query?: Record<string, string | number | undefined>; signal?: AbortSignal },
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

    async listSwarmRuns(params?: { sessionId?: string; limit?: number; signal?: AbortSignal }): Promise<SwarmRunRecord[]> {
      const data = await req<{ items?: SwarmRunRecord[] }>('GET', '/v1/swarm/runs', {
        query: { sessionId: params?.sessionId, limit: params?.limit },
        signal: params?.signal,
      });
      return data.items ?? [];
    },

    submitSwarmRun(input: {
      goal: string;
      sessionId?: string;
      workspaceRoot?: string;
      permissionMode?: string;
      maxConcurrency?: number;
      budget?: Record<string, unknown>;
      nodes?: unknown[];
      maxReplans?: number;
      wait?: boolean;
    }): Promise<SwarmSubmitResponse> {
      return req('POST', '/v1/swarm/runs', { body: input });
    },

    getSwarmRun(id: string): Promise<SwarmRunRecord> {
      return req('GET', `/v1/swarm/runs/${encodeURIComponent(id)}`);
    },

    resumeSwarmRun(id: string): Promise<SwarmRunRecord> {
      return req('POST', `/v1/swarm/runs/${encodeURIComponent(id)}/resume`);
    },

    cancelSwarmRun(id: string): Promise<SwarmRunRecord> {
      return req('POST', `/v1/swarm/runs/${encodeURIComponent(id)}/cancel`);
    },

    async listSwarmMessages(runId: string, signal?: AbortSignal): Promise<SwarmMessageRecord[]> {
      const data = await req<{ items: SwarmMessageRecord[] }>('GET', '/v1/communication/messages', {
        query: { runId }, signal,
      });
      return data.items;
    },

    async listSwarmReplans(id: string, signal?: AbortSignal): Promise<SwarmReplanRecord[]> {
      const data = await req<{ items?: SwarmReplanRecord[] }>(
        'GET',
        `/v1/swarm/runs/${encodeURIComponent(id)}/replans`,
        { signal },
      );
      return data.items ?? [];
    },

    async listSwarmArtifacts(
      runId: string,
      params?: { nodeKey?: string; limit?: number; signal?: AbortSignal },
    ): Promise<SwarmArtifactRecord[]> {
      const data = await req<{ items?: SwarmArtifactRecord[] }>(
        'GET',
        `/v1/swarm/runs/${encodeURIComponent(runId)}/artifacts`,
        { query: { nodeKey: params?.nodeKey, limit: params?.limit }, signal: params?.signal },
      );
      return data.items ?? [];
    },

    getSwarmArtifact(
      runId: string,
      artifactId: string,
      path?: string,
    ): Promise<SwarmArtifactRecord | Record<string, unknown>> {
      return req(
        'GET',
        `/v1/swarm/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}`,
        { query: { path } },
      );
    },

    readSwarmArtifactFile(runId: string, artifactId: string, path: string, signal?: AbortSignal): Promise<SwarmArtifactFile> {
      return req(
        'GET',
        `/v1/swarm/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}`,
        { query: { path }, signal },
      );
    },

    verifySwarmArtifact(
      runId: string,
      artifactId: string,
    ): Promise<{ ok: boolean; artifactId: string; bundleSha256?: string; errors?: string[]; checkedFiles?: number }> {
      return req(
        'POST',
        `/v1/swarm/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}/verify`,
      );
    },

    applySwarmArtifact(
      runId: string,
      artifactId: string,
      input?: { permissionMode?: string; approved?: boolean; targetWorkspaceRoot?: string },
    ): Promise<Record<string, unknown>> {
      return req(
        'POST',
        `/v1/swarm/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}/apply`,
        { body: input ?? {} },
      );
    },

    async listSessionNotifications(
      sessionId: string,
      unreadOnly = false,
    ): Promise<ChildNotificationRecord[]> {
      const data = await req<{ items?: ChildNotificationRecord[] }>(
        'GET',
        `/v1/sessions/${encodeURIComponent(sessionId)}/notifications`,
        { query: unreadOnly ? { unreadOnly: 'true' } : undefined },
      );
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
      timezone?: string;
      concurrencyPolicy?: string;
      misfirePolicy?: string;
      maxConcurrency?: number;
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
        timezone: string;
        concurrencyPolicy: string;
        misfirePolicy: string;
        maxConcurrency: number;
        workspaceRoot: string | null;
        model: string | null;
        permissionMode: string;
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
      run?: ScheduleRunRecord;
      session: { id: string };
      turn: { id: string };
    }> {
      return req('POST', `/v1/schedules/${encodeURIComponent(id)}/run`);
    },

    async listScheduleRuns(id: string, limit = 50): Promise<ScheduleRunRecord[]> {
      const data = await req<{ items?: ScheduleRunRecord[] }>(
        'GET',
        `/v1/schedules/${encodeURIComponent(id)}/runs`,
        { query: { limit } },
      );
      return data.items ?? [];
    },

    cancelScheduleRun(id: string, runId: string): Promise<ScheduleRunRecord> {
      return req(
        'POST',
        `/v1/schedules/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}/cancel`,
      );
    },
  };
}
