import React from "react";
import { interpolate, useCurrentFrame } from "remotion";
import {
  COLORS,
  FONT_MONO,
  FONT_SANS,
  HEIGHT,
  WIDTH,
  fadeInUp,
  sceneEnvelopeOpacity,
  springSnappy,
} from "../theme";

interface LayerDef {
  layer: string;
  title: string;
  files: string;
  color: string;
  origin: string;
  bullets: string[];
  delay: number;
}

const LAYERS: LayerDef[] = [
  {
    layer: "LAYER 01",
    title: "Codex 1:1 Desktop & Web UI",
    files: "frontend/ + desktop/",
    color: COLORS.cyan,
    origin: "对标 OpenAI Codex 26.1111 桌面规范",
    bullets: [
      "Electron 35 桌面壳 + Extension Hub + 0.15s cubic-bezier 动效引擎",
      "SSE Last-Event-ID 断线无损重放 + 12.5px 命令卡 + 40×40 Diff 检查器",
    ],
    delay: 18,
  },
  {
    layer: "LAYER 02",
    title: "Deterministic Task Engine & SQLite WAL",
    files: "engine.js · store.js",
    color: COLORS.emeraldBright,
    origin: "融合 SuperAgent 领域模型",
    bullets: [
      "BEGIN IMMEDIATE 事务乐观锁 + revisions 不可变历史 + 幂等键防重",
      "Durable Outbox 事务后副作用 + 15s Fencing Token 租约 (2s 心跳续租)",
    ],
    delay: 46,
  },
  {
    layer: "LAYER 03",
    title: "DSH Cordis Runtime & Capability Router",
    files: "bundle.js · router.js · session.js",
    color: COLORS.violet,
    origin: "扩展 DeepSeek Harness (DSH)",
    bullets: [
      "Router 专注拓扑 DAG 分解与独立验收，不直接持有高危 Shell 权限",
      "按能力/上下文/延迟/费率动态路由 Coder / Tester / Verifier (峰值 4 路并发)",
    ],
    delay: 74,
  },
  {
    layer: "LAYER 04",
    title: "7-Gate Governance & Zero-Network Sandbox",
    files: "tools.js · docker.js",
    color: COLORS.amber,
    origin: "复刻 Codex 执行边界 + Claude Hooks",
    bullets: [
      "7 级执行门：Schema → 授权 → 路径/网络策略 → 沙箱 → 一次性审批 → 执行 → 证据",
      "Docker --network none · 非 root UID · cap-drop ALL · 只读 rootfs · Codex PTY",
    ],
    delay: 102,
  },
  {
    layer: "LAYER 05",
    title: "Magpie Sidecar & Native Dual-Path Gateway",
    files: "magpie.js · providers.js · vault.js",
    color: COLORS.magpie,
    origin: "集成 Magpie v0.1.4490 + 原生降级",
    bullets: [
      "AES-256-GCM 密封密钥库 (stdin 注入 tmpfs，零明文落盘)",
      "127.0.0.1:3425 私有网关统一多协议，网关异常秒级切换 Direct Adapter",
    ],
    delay: 130,
  },
];

export const Scene2Architecture: React.FC = () => {
  const frame = useCurrentFrame();
  const duration = 510;
  const envelope = sceneEnvelopeOpacity(frame, duration);
  const headerAnim = fadeInUp(frame, 4, 24);

  const busProgress = interpolate(frame, [20, 210], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        width: WIDTH,
        height: HEIGHT,
        opacity: envelope,
        fontFamily: FONT_SANS,
        color: COLORS.textPrimary,
      }}
    >
      {/* Header */}
      <div
        style={{
          position: "absolute",
          top: 96,
          left: 84,
          right: 84,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-end",
          ...headerAnim,
        }}
      >
        <div>
          <div
            style={{
              fontFamily: FONT_MONO,
              fontSize: 13,
              color: COLORS.cyan,
              letterSpacing: "0.14em",
              fontWeight: 700,
              marginBottom: 8,
            }}
          >
            FIVE-LAYER DECOUPLED SYSTEM TOPOLOGY
          </div>
          <h2 style={{ margin: 0, fontSize: 44, fontWeight: 800 }}>
            五层解耦架构蓝图：单主循环、单事实源、硬隔离边界
          </h2>
        </div>

        <div
          style={{
            padding: "10px 18px",
            borderRadius: 12,
            backgroundColor: "rgba(16, 185, 129, 0.12)",
            border: "1px solid rgba(16, 185, 129, 0.35)",
            fontFamily: FONT_MONO,
            fontSize: 14,
            color: COLORS.emeraldBright,
            fontWeight: 600,
          }}
        >
          REST + SSE /api/v1 · SQLite WAL · Docker Linux
        </div>
      </div>

      {/* Left Vertical Data Bus SVG */}
      <svg
        width={WIDTH}
        height={HEIGHT}
        style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
      >
        <line
          x1={144}
          y1={240}
          x2={144}
          y2={240 + 680 * busProgress}
          stroke="url(#busGrad)"
          strokeWidth={4}
          strokeLinecap="round"
        />
        <defs>
          <linearGradient id="busGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={COLORS.cyan} />
            <stop offset="30%" stopColor={COLORS.emeraldBright} />
            <stop offset="60%" stopColor={COLORS.violet} />
            <stop offset="85%" stopColor={COLORS.amber} />
            <stop offset="100%" stopColor={COLORS.magpie} />
          </linearGradient>
        </defs>

        {/* Moving Telemetry Packets up and down the bus */}
        {[0, 1, 2].map((idx) => {
          const cycle = ((frame * 0.012 + idx * 0.33) % 1);
          const yPos = 250 + cycle * 670;
          return (
            <circle
              key={idx}
              cx={144}
              cy={yPos}
              r={6}
              fill="#FFFFFF"
              opacity={busProgress > 0.4 ? 0.9 : 0}
            />
          );
        })}
      </svg>

      {/* 5 Stacked Layer Cards */}
      <div
        style={{
          position: "absolute",
          top: 222,
          left: 192,
          right: 84,
          display: "flex",
          flexDirection: "column",
          gap: 16,
        }}
      >
        {LAYERS.map((item, idx) => {
          const p = springSnappy(frame, item.delay);
          const slideX = interpolate(p, [0, 1], [60, 0]);
          const highlight =
            frame >= item.delay + 20 && frame < item.delay + 120;

          return (
            <div
              key={item.layer}
              style={{
                position: "relative",
                height: 132,
                borderRadius: 16,
                padding: "18px 26px",
                backgroundColor: COLORS.bgCard,
                border: `1.5px solid ${
                  highlight ? item.color : `${item.color}45`
                }`,
                boxShadow: highlight
                  ? `0 0 36px ${item.color}28, 0 10px 28px rgba(0,0,0,0.4)`
                  : "0 8px 24px rgba(0,0,0,0.35)",
                opacity: p,
                transform: `translateX(${slideX}px)`,
                display: "grid",
                gridTemplateColumns: "390px 1fr 290px",
                alignItems: "center",
                gap: 24,
              }}
            >
              {/* Node connector dot onto vertical bus */}
              <div
                style={{
                  position: "absolute",
                  left: -56,
                  top: "50%",
                  transform: "translateY(-50%)",
                  width: 16,
                  height: 16,
                  borderRadius: 99,
                  backgroundColor: item.color,
                  border: "3px solid #050811",
                  boxShadow: `0 0 14px ${item.color}`,
                }}
              />
              <div
                style={{
                  position: "absolute",
                  left: -40,
                  top: "50%",
                  width: 40,
                  height: 2,
                  backgroundColor: `${item.color}88`,
                }}
              />

              {/* Col 1: Title & File */}
              <div>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    marginBottom: 6,
                  }}
                >
                  <span
                    style={{
                      fontFamily: FONT_MONO,
                      fontSize: 12,
                      fontWeight: 800,
                      padding: "2px 8px",
                      borderRadius: 5,
                      backgroundColor: `${item.color}22`,
                      color: item.color,
                    }}
                  >
                    {item.layer}
                  </span>
                  <span
                    style={{
                      fontFamily: FONT_MONO,
                      fontSize: 12,
                      color: COLORS.textSecondary,
                    }}
                  >
                    {item.files}
                  </span>
                </div>
                <div style={{ fontSize: 21, fontWeight: 700, lineHeight: 1.25 }}>
                  {item.title}
                </div>
              </div>

              {/* Col 2: Key Engineering Details */}
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 7,
                  fontSize: 15,
                  color: "#E2E8F0",
                }}
              >
                {item.bullets.map((b) => (
                  <div key={b} style={{ display: "flex", gap: 8 }}>
                    <span style={{ color: item.color, fontWeight: 700 }}>▸</span>
                    <span>{b}</span>
                  </div>
                ))}
              </div>

              {/* Col 3: Architectural Origin Badge */}
              <div
                style={{
                  justifySelf: "end",
                  textAlign: "right",
                  padding: "10px 14px",
                  borderRadius: 10,
                  backgroundColor: "rgba(15, 23, 42, 0.8)",
                  border: `1px solid ${item.color}33`,
                }}
              >
                <div
                  style={{
                    fontFamily: FONT_MONO,
                    fontSize: 11,
                    color: item.color,
                    fontWeight: 700,
                    marginBottom: 4,
                  }}
                >
                  ARCHITECTURAL EDGE #{idx + 1}
                </div>
                <div style={{ fontSize: 14, color: COLORS.textSecondary }}>
                  {item.origin}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
