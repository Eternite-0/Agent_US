import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { C, MONO, lerp, prog, rise } from "../theme";
import { Blue, Icon, SceneTitle } from "../ui";

const MODELS = [
  { m: "gpt-5", src: "OpenAI 协议", ctx: 400, cap: ["视觉", "工具"] },
  { m: "claude-sonnet-4.5", src: "Anthropic 协议", ctx: 200, cap: ["视觉", "工具"] },
  { m: "gemini-2.5-pro", src: "OpenAI 协议", ctx: 1000, cap: ["视觉", "工具"] },
  { m: "deepseek-v3.2", src: "OpenAI 协议", ctx: 128, cap: ["工具"] },
  { m: "qwen3-coder", src: "本地网关", ctx: 256, cap: ["工具"] },
  { m: "kimi-k2", src: "OpenAI 协议", ctx: 256, cap: ["工具"] },
];

const ModelPanel: React.FC<{ f: number }> = ({ f }) => {
  const fetching = f >= 96 && f < 130;
  return (
    <div
      style={{
        ...rise(f, 30, 30, 40),
        position: "absolute",
        left: 110,
        top: 300,
        width: 900,
        borderRadius: 24,
        background: "#fff",
        border: `1px solid ${C.line}`,
        boxShadow: "0 40px 80px -40px rgba(23,71,201,0.4)",
        overflow: "hidden",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "20px 26px", borderBottom: `1px solid ${C.lineSoft}` }}>
        <Icon name="cube" size={24} color={C.blue} />
        <span style={{ fontSize: 24, fontWeight: 720, color: C.ink }}>模型管理</span>
        <span style={{ fontSize: 16, color: C.sub }}>{f >= 130 ? "6 个模型 · 已热接入后端对话" : "获取模型与别名映射"}</span>
        <div style={{ flex: 1 }} />
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            padding: "10px 18px",
            borderRadius: 12,
            background: C.blue,
            color: "#fff",
            fontSize: 17,
            fontWeight: 650,
            transform: `scale(${f >= 90 && f < 100 ? 0.94 : 1})`,
            boxShadow: "0 10px 20px -10px rgba(37,99,235,0.7)",
          }}
        >
          {fetching ? (
            <span
              style={{
                width: 15,
                height: 15,
                borderRadius: 99,
                border: "2.5px solid rgba(255,255,255,0.4)",
                borderTopColor: "#fff",
                transform: `rotate(${f * 14}deg)`,
              }}
            />
          ) : (
            <Icon name="zap" size={16} color="#fff" />
          )}
          {fetching ? "获取中…" : "获取模型"}
        </span>
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1.6fr 1.2fr 0.9fr 1.1fr 0.7fr",
          padding: "12px 26px",
          fontSize: 15,
          color: C.muted,
          fontWeight: 600,
          background: C.chrome,
        }}
      >
        <span>模型</span>
        <span>来源</span>
        <span>上下文</span>
        <span>能力</span>
        <span>状态</span>
      </div>
      {MODELS.map((r, i) => {
        const at = 130 + i * 14;
        const a = prog(f, at, 20);
        const ctx = Math.round(lerp(prog(f, at, 40), 0, r.ctx));
        return (
          <div
            key={r.m}
            style={{
              display: "grid",
              gridTemplateColumns: "1.6fr 1.2fr 0.9fr 1.1fr 0.7fr",
              alignItems: "center",
              padding: "0 26px",
              height: 58,
              fontSize: 18,
              borderTop: `1px solid ${C.lineSoft}`,
              opacity: a,
              transform: `translateY(${(1 - a) * 14}px)`,
            }}
          >
            <span style={{ fontFamily: MONO, fontWeight: 650, color: C.ink, fontSize: 17 }}>{r.m}</span>
            <span style={{ color: C.sub, fontSize: 16 }}>{r.src}</span>
            <span style={{ fontFamily: MONO, color: C.blueDeep, fontSize: 17 }}>{ctx >= 1000 ? "1M" : `${ctx}K`}</span>
            <span style={{ display: "flex", gap: 6 }}>
              {r.cap.map((c) => (
                <span key={c} style={{ fontSize: 13, padding: "3px 9px", borderRadius: 6, background: C.ice, color: C.blue, fontWeight: 600 }}>
                  {c}
                </span>
              ))}
            </span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 15, color: C.green, fontWeight: 600 }}>
              <span style={{ width: 8, height: 8, borderRadius: 9, background: C.green }} /> 启用
            </span>
          </div>
        );
      })}
      <div
        style={{
          display: "flex",
          gap: 12,
          padding: "16px 26px 20px",
          borderTop: `1px solid ${C.lineSoft}`,
          opacity: prog(f, 260, 24),
          fontSize: 16,
          alignItems: "center",
          color: C.sub,
        }}
      >
        别名映射
        {[
          ["fast", "deepseek-v3.2"],
          ["vision", "gemini-2.5-pro"],
          ["coder", "qwen3-coder"],
        ].map(([a, b]) => (
          <span key={a} style={{ fontFamily: MONO, fontSize: 15, padding: "6px 12px", borderRadius: 10, background: C.ice, color: C.blueDeep }}>
            {a} → {b}
          </span>
        ))}
      </div>
    </div>
  );
};

const NODE_Y = 700;
const ACC = [
  { x: 1180, label: "账号 A", sub: "OpenAI 协议" },
  { x: 1450, label: "账号 B", sub: "Anthropic 协议" },
  { x: 1720, label: "账号 C", sub: "本地网关" },
];
const CORE = { x: 1450, y: 400 };

const Failover: React.FC<{ f: number }> = ({ f }) => {
  const appear = prog(f, 200, 30);
  const p1 = prog(f, 330, 40);
  const failA = f >= 372;
  const p2 = prog(f, 410, 40);
  const okB = f >= 452;
  const packet = (p: number, tx: number) => ({ x: lerp(p, CORE.x, tx), y: lerp(p, CORE.y + 60, NODE_Y - 60) });
  const pk1 = packet(p1, ACC[0].x);
  const pk2 = packet(p2, ACC[1].x);
  return (
    <div style={{ position: "absolute", inset: 0, opacity: appear }}>
      <svg width={1920} height={1080} style={{ position: "absolute", inset: 0 }}>
        {ACC.map((a, i) => (
          <line
            key={i}
            x1={CORE.x}
            y1={CORE.y + 60}
            x2={a.x}
            y2={NODE_Y - 60}
            stroke={i === 0 && failA ? C.amber : i === 1 && okB ? C.blue : C.iceDeep}
            strokeWidth={i === 1 && okB ? 4 : 3}
            strokeDasharray={i === 0 && failA ? "8 8" : undefined}
          />
        ))}
        {okB &&
          Array.from({ length: 4 }).map((_, k) => {
            const t = (((f - 452) / 50 + k / 4) % 1 + 1) % 1;
            return (
              <circle
                key={k}
                cx={lerp(t, ACC[1].x, CORE.x)}
                cy={lerp(t, NODE_Y - 60, CORE.y + 60)}
                r={6}
                fill={C.blue}
                opacity={Math.sin(t * Math.PI)}
              />
            );
          })}
        {f >= 330 && f < 374 && <circle cx={pk1.x} cy={pk1.y} r={9} fill={C.blueMid} />}
        {f >= 410 && f < 454 && <circle cx={pk2.x} cy={pk2.y} r={9} fill={C.blueMid} />}
      </svg>
      <div
        style={{
          position: "absolute",
          left: CORE.x - 150,
          top: CORE.y - 60,
          width: 300,
          height: 120,
          borderRadius: 26,
          background: `linear-gradient(140deg, ${C.blueMid}, ${C.blueDeep})`,
          color: "#fff",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 14,
          fontSize: 26,
          fontWeight: 720,
          boxShadow: "0 30px 50px -24px rgba(23,71,201,0.7)",
        }}
      >
        <Icon name="bot" size={34} color="#fff" /> Agent 内核
      </div>
      {ACC.map((a, i) => {
        const bad = i === 0 && failA;
        const good = i === 1 && okB;
        const s = prog(f, 220 + i * 10, 24);
        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: a.x - 115,
              top: NODE_Y - 60,
              width: 230,
              height: 120,
              borderRadius: 22,
              background: "#fff",
              border: `2px solid ${bad ? C.amber : good ? C.blue : C.line}`,
              boxShadow: good ? "0 0 0 8px rgba(37,99,235,0.12), 0 24px 40px -24px rgba(23,71,201,0.5)" : "0 20px 40px -28px rgba(11,27,58,0.4)",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              opacity: s,
              transform: `scale(${0.85 + s * 0.15})`,
            }}
          >
            <div style={{ fontSize: 23, fontWeight: 720, color: C.ink, display: "flex", alignItems: "center", gap: 8 }}>
              <Icon name="lock" size={18} color={C.blue} />
              {a.label}
            </div>
            <div style={{ fontSize: 16, color: C.sub, marginTop: 4 }}>{a.sub}</div>
            <div
              style={{
                marginTop: 8,
                fontSize: 14,
                fontWeight: 700,
                padding: "3px 10px",
                borderRadius: 8,
                background: bad ? C.amberSoft : good ? C.greenSoft : "rgba(11,27,58,0.04)",
                color: bad ? C.amber : good ? C.green : C.muted,
                fontFamily: MONO,
              }}
            >
              {bad ? `429 · 冷却 ${Math.max(0, 60 - Math.floor((f - 372) / 6))}s` : good ? "200 · 流式中" : "待命"}
            </div>
          </div>
        );
      })}
      <div
        style={{
          position: "absolute",
          left: 1100,
          top: 860,
          width: 700,
          textAlign: "center",
          fontSize: 22,
          color: C.blueDeep,
          fontWeight: 650,
          opacity: prog(f, 470, 24),
        }}
      >
        ⚡ 故障 0.3 秒内自动转移 · 对话零中断
      </div>
    </div>
  );
};

export const S6Pool: React.FC = () => {
  const f = useCurrentFrame();
  return (
    <AbsoluteFill>
      <SceneTitle
        kicker="核心创新 · 永不掉线"
        title={<>多供应商<Blue>号池网关</Blue></>}
        desc="一个入口，接入所有主流模型 —— 自动同步能力元数据，额度耗尽自动切换"
        at={4}
        x={110}
        y={70}
        width={1700}
      />
      <ModelPanel f={f} />
      <Failover f={f} />
      <div style={{ position: "absolute", left: 110, top: 930, display: "flex", gap: 14 }}>
        {["AES-256-GCM 凭证加密", "OpenAI / Anthropic 双协议", "上下文与视觉能力自动同步", "429 冷却与顺位调度"].map((t, i) => (
          <span
            key={t}
            style={{
              ...rise(f, 540 + i * 8, 24, 14),
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              padding: "11px 18px",
              borderRadius: 999,
              background: "#fff",
              border: `1px solid ${C.iceDeep}`,
              fontSize: 19,
              fontWeight: 600,
              color: C.blueDeep,
            }}
          >
            <Icon name="check" size={17} color={C.blue} stroke={2.6} /> {t}
          </span>
        ))}
      </div>
    </AbsoluteFill>
  );
};
