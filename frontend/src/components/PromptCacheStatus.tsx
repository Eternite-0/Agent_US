import { createContext, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { IconChevronDown, IconDatabase, IconRefresh } from './Icons';
import type { AgentBackendClient } from '../api/client';
import { cachePercent, type PromptCacheStats } from '../utils/promptCache';

type Reading = {
  client: AgentBackendClient;
  data?: PromptCacheStats;
  state: 'loading' | 'ready' | 'legacy' | 'error' | 'demo';
  refreshing: boolean;
};

const PromptCacheContext = createContext<(Reading & { refresh: () => void }) | null>(null);

/** Share one connection-scoped snapshot between the home and thread composers. */
export function PromptCacheProvider({ client, revision, children }: {
  client: AgentBackendClient;
  revision: string;
  children: ReactNode;
}) {
  const [reading, setReading] = useState<Reading>();
  const [refreshCount, setRefreshCount] = useState(0);
  const supportsMetrics = Boolean(client.getPromptCacheStats);
  useEffect(() => {
    if (!client.getPromptCacheStats) return;
    const controller = new AbortController();
    const refresh = async () => {
      setReading(previous => ({
        ...(previous?.client === client ? previous : { client, state: 'loading' }), refreshing: true,
      }));
      try {
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]);
        const data = await client.getPromptCacheStats!(signal);
        if (!controller.signal.aborted) {
          setReading({ client, data: data ?? undefined, state: data ? 'ready' : 'legacy', refreshing: false });
        }
      } catch {
        if (!controller.signal.aborted) {
          setReading(previous => ({
            client, data: previous?.client === client ? previous.data : undefined, state: 'error', refreshing: false,
          }));
        }
      }
    };
    // Coalesce terminal SSE events, and allow the last usage snapshot to settle.
    const first = window.setTimeout(refresh, revision ? 250 : 0);
    const poll = window.setInterval(refresh, 30_000);
    return () => { controller.abort(); window.clearTimeout(first); window.clearInterval(poll); };
  }, [client, revision, refreshCount]);

  const value = useMemo(() => ({
    ...(reading?.client === client ? reading : {
      client, state: supportsMetrics ? 'loading' as const : 'demo' as const, refreshing: supportsMetrics,
    }),
    refresh: () => setRefreshCount(count => count + 1),
  }), [client, reading, supportsMetrics]);
  return <PromptCacheContext.Provider value={value}>{children}</PromptCacheContext.Provider>;
}

const format = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
const exact = new Intl.NumberFormat();
const tokens = (n?: number | null) => n == null ? '—' : format.format(n);
const full = (n?: number | null) => n == null ? '未报告' : exact.format(n);

export function PromptCacheStatus() {
  const reading = useContext(PromptCacheContext);
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !container.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', closeOutside);
    return () => document.removeEventListener('pointerdown', closeOutside);
  }, [open]);

  if (!reading) return null;
  const { data, state, refreshing, refresh } = reading;
  const stats = data?.global;
  const hours = data?.windowHours ?? 24;
  const status = state === 'loading' ? '正在加载'
    : state === 'legacy' ? '后端版本过旧'
      : state === 'demo' ? '演示模式'
        : state === 'error' ? (stats ? '更新失败 · 上次数据' : '连接失败')
          : !stats?.requests ? '暂无请求'
            : stats.status === 'unavailable' ? '无可用遥测'
              : stats.status === 'partial' ? '部分请求有数据' : '可用';
  const note = state === 'legacy' ? '当前后端未提供缓存遥测。请用当前版本重新启动后端，再发起一次模型请求。'
    : state === 'error' ? '未能读取缓存指标，请确认后端连接后重试。'
      : state === 'demo' ? '连接真实后端后才可查看缓存数据。'
        : state === 'ready' && !stats?.requests ? '这段时间还没有记录到模型请求。'
          : state === 'ready' && stats?.status === 'unavailable' ? '供应商没有返回可用于计算命中率的完整缓存用量；这不等于 0% 命中。'
            : undefined;
  return <div className="prompt-cache-wrap" ref={container} onKeyDown={event => {
    if (!open || event.key !== 'Escape') return;
    event.stopPropagation();
    setOpen(false);
    trigger.current?.focus();
  }}>
    <button type="button" ref={trigger} className="prompt-cache-status" aria-label={`Prompt Cache：缓存命中 ${cachePercent(stats?.hitRate)}，${status}`} aria-expanded={open}
      aria-controls={open ? panelId : undefined} onClick={() => setOpen(value => !value)}>
      <IconDatabase size={14} aria-hidden="true" />
      <span>缓存命中 {cachePercent(stats?.hitRate)}</span>
      <span>读取 {tokens(stats?.cacheReadTokens)}</span>
      <span>创建 {tokens(stats?.cacheWriteTokens)}</span>
      <span>近 {hours} 小时 · {status}</span>
      <IconChevronDown size={12} className="prompt-cache-chevron" aria-hidden="true" />
    </button>
    {open && <section id={panelId} aria-label="缓存详情" className="codex-popover prompt-cache-panel" data-side="top">
      <header>
        <strong>缓存详情 · 近 {hours} 小时</strong>
        {state !== 'demo' && <button type="button" className="codex-icon-btn" aria-label="刷新缓存数据" title="刷新缓存数据"
          aria-disabled={refreshing} onClick={() => { if (!refreshing) refresh(); }}>
          <IconRefresh size={14} aria-hidden="true" />
        </button>}
      </header>
      <p role="status">{refreshing ? '正在更新缓存数据…' : note ?? status}</p>
      {stats && <>
        <dl>
          <dt>命中率</dt><dd>{cachePercent(stats.hitRate)}</dd>
          <dt>读取 / 创建 Token</dt><dd>{full(stats.cacheReadTokens)} / {full(stats.cacheWriteTokens)}</dd>
          <dt>遥测覆盖率</dt><dd>{cachePercent(stats.coverage)}（{stats.measuredRequests}/{stats.requests} 次请求）</dd>
        </dl>
        <p>命中率只按供应商已报告完整缓存用量的请求计算。未报告 {stats.missingRequests} 次，不支持 {stats.unsupportedRequests} 次。</p>
      </>}
    </section>}
  </div>;
}
