import { createContext, useContext, useEffect, useState } from 'react';
import { IconDatabase } from './Icons';
import type { AgentBackendClient } from '../api/client';
import { cachePercent, type PromptCacheStats } from '../utils/promptCache';

export const PromptCacheContext = createContext<{ client: AgentBackendClient; revision: string } | null>(null);

const format = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
const exact = new Intl.NumberFormat();
const tokens = (n?: number | null) => n == null ? '—' : format.format(n);
const full = (n?: number | null) => n == null ? '未知' : exact.format(n);

export function PromptCacheStatus() {
  const connection = useContext(PromptCacheContext);
  const client = connection?.client;
  const [snapshot, setSnapshot] = useState<{ client: AgentBackendClient; data: PromptCacheStats } | null>(null);
  useEffect(() => {
    if (!client?.getPromptCacheStats) return;
    const controller = new AbortController();
    let generation = 0;
    const refresh = async () => {
      const n = ++generation;
      try {
        const data = await client.getPromptCacheStats!(controller.signal);
        if (!controller.signal.aborted && n === generation) setSnapshot(data ? { client, data } : null);
      } catch {
        if (!controller.signal.aborted && n === generation) setSnapshot(null);
      }
    };
    // Terminal events can arrive just before usage from an aborted stream settles.
    const first = window.setTimeout(refresh, connection?.revision ? 250 : 0);
    const poll = window.setInterval(refresh, 30_000);
    return () => { controller.abort(); window.clearTimeout(first); window.clearInterval(poll); };
  }, [client, connection?.revision]);
  const data = snapshot?.client === client ? snapshot?.data : undefined;
  const stats = data?.global;
  const state = stats?.status === 'available' ? '可用' : stats?.status === 'partial' ? '部分可用' : '未知';
  const tip = stats ? [
    `生产数据 · 最近 ${data?.windowHours ?? 24} 小时`,
    `缓存命中率 = 读取量 ÷ 可统计输入量`,
    `读取 ${full(stats.cacheReadTokens)} · 创建 ${full(stats.cacheWriteTokens)} · 未命中 ${full(stats.uncachedInputTokens)} Token`,
    `覆盖率 ${cachePercent(stats.coverage)}（${stats.measuredRequests}/${stats.requests} 次请求；缺失 ${stats.missingRequests}，不支持 ${stats.unsupportedRequests}）`,
  ].join('\n') : '最近 24 小时暂无可用的生产缓存遥测';
  return <div className="prompt-cache-status" role="group" aria-label="Prompt Cache" tabIndex={0} title={tip}>
    <IconDatabase size={14} aria-hidden="true" />
    <span>缓存命中 {cachePercent(stats?.hitRate)}</span>
    <span>读取 {tokens(stats?.cacheReadTokens)}</span>
    <span>创建 {tokens(stats?.cacheWriteTokens)}</span>
    <span>近 {data?.windowHours ?? 24} 小时 · {state}</span>
  </div>;
}
