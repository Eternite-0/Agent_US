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
  springSmooth,
  springSnappy,
} from "../theme";

interface PillarCard {
  name: string;
  tag: string;
  color: string;
  strength: string;
  limitation: string;
  x: number;
  y: number;
  delay: number;
}

const SOURCE_PILLARS: PillarCard[] = [
  {
    name: "Claude Code",
    tag: "HARNESS PATTERNS",
    color: COLORS.claude,
    strength: "强于 Context Compaction、系统提示词分层与 Hooks 生命周期治理",
    limitation: "局限：单会话线性 Turn 循环，缺持久化 DAG 状态机与容器硬边界",
    x: 92,
    y: 332,
    delay: 24,
  },
  {
    name: "OpenAI Codex",
    tag: "EXECUTION & UI SPEC",
    color: COLORS.codex,
    strength: "强于 command/exec PTY、强类型审批动作与极致桌面交互规范",
    limitation: "局限：重度耦合 Rust 构建链，缺多角色拓扑并发与多网关容灾",
    x: 92,
    y: 540,
    delay: 40,
  },
  {
    name: "DeepSeek Harness (DSH)",
    tag: "CORDIS RUNTIME",
    color: COLORS.dsh,
    strength: "强于 Cordis 可组合插件服务、AgentLoop 与 SessionLog 解耦底座",
    limitation: "局限：原生为通用运行时，缺 Outbox 事务、15s 租约恢复与无网沙箱",
    x: 92,
    y: 748,
    delay: 56,
  },
];

const FUSION_CHIPS = [
  { label: "SQLite WAL + Durable Outbox", color: COLORS.emeraldBright },
  { label: "拓扑 DAG + 4 路并发快照", color: COLORS.cyan },
  { label: "Docker --network none + Codex PTY", color: COLORS.indigo },
  { label: "Magpie 网关 + 原生直连双路容灾", color: COLORS.magpie },
];

export const Scene1HeroProblem: React.FC = () => {
  const frame = useCurrentFrame();
  const duration = 420;
  const envelope = sceneEnvelopeOpacity(frame, duration);

  const titleAnim = fadeInUp(frame, 4, 24);
  const coreScale = springSmooth(frame, 88);
  const streamProgress = interpolate(frame, [78, 175], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const pulse = 0.65 + 0.35 * Math.sin(frame * 0.12);
  const ringRotate = (frame * 0.6) % 360;

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
      {/* Hero Headline */}
      <div
        style={{
          position: "absolute",
          top: 108,
          left: 92,
          right: 92,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-end",
          ...titleAnim,
        }}
      >
        <div>
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 10,
              padding: "6px 14px",
              borderRadius: 99,
              backgroundColor: "rgba(16, 185, 129, 0.12)",
              border: "1px solid rgba(16, 185, 129, 0.35)",
              color: COLORS.emeraldBright,
              fontFamily: FONT_MONO,
              fontSize: 13,
              fontWeight: 700,
              letterSpacing: "0.08em",
              marginBottom: 14,
            }}
          >
            NEXT-GEN GOVERNED MULTI-AGENT ARCHITECTURE
          </div>
          <h1
            style={{
              margin: 0,
              fontSize: 56,
              fontWeight: 800,
              letterSpacing: "-0.02em",
              lineHeight: 1.12,
              background: `linear-gradient(95deg, #FFFFFF 20%, ${COLORS.cyan} 65%, ${COLORS.emeraldBright} 100%)`,
              WebkitBackgroundClip: "text",
              WebkitTextFillColor: "transparent",
            }}
          >
            AGENT_US：取四大标杆之长，重构企业级自治引擎
          </h1>
          <p
            style={{
              margin: "12px 0 0 0",
              fontSize: 21,
              color: COLORS.textSecondary,
              maxWidth: 1180,
            }}
          >
            告别单一工具链的并发瓶颈与安全盲区——将 DSH 可组合内核、SuperAgent 任务域、Codex 执行沙箱、Claude 治理模式与 Magpie 网关深度融合
          </p>
        </div>
      </div>

      {/* SVG Animated Convergence Energy Streams */}
      <svg
        width={WIDTH}
        height={HEIGHT}
        style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
      >
        <defs>
          <filter id="beamGlow" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation="4" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {SOURCE_PILLARS.map((p, idx) => {
          const startX = p.x + 560;
          const startY = p.y + 84;
          const endX = 1110;
          const endY = 615;
          const cp1x = startX + 200;
          const cp1y = startY;
          const cp2x = endX - 200;
          const cp2y = endY;
          const pathD = `M ${startX} ${startY} C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${endX} ${endY}`;
          const pathLength = 620;
          const dashOffset = pathLength * (1 - streamProgress);

          // Particle position along bezier
          const t = ((frame * 0.015 + idx * 0.33) % 1);
          const u = 1 - t;
          const px =
            u * u * u * startX +
            3 * u * u * t * cp1x +
            3 * u * t * t * cp2x +
            t * t * t * endX;
          const py =
            u * u * u * startY +
            3 * u * u * t * cp1y +
            3 * u * t * t * cp2y +
            t * t * t * endY;

          return (
            <g key={p.name}>
              <path
                d={pathD}
                fill="none"
                stroke="rgba(148, 163, 184, 0.14)"
                strokeWidth={2}
                strokeDasharray="6 6"
              />
              <path
                d={pathD}
                fill="none"
                stroke={p.color}
                strokeWidth={3}
                strokeDasharray={pathLength}
                strokeDashoffset={dashOffset}
                filter="url(#beamGlow)"
                opacity={0.85}
              />
              {streamProgress > 0.35 && (
                <circle
                  cx={px}
                  cy={py}
                  r={6}
                  fill="#FFFFFF"
                  stroke={p.color}
                  strokeWidth={3}
                  filter="url(#beamGlow)"
                />
              )}
            </g>
          );
        })}

        {/* Magpie Sidecar bottom-up stream */}
        {(() => {
          const startX = 1435;
          const startY = 895;
          const endX = 1435;
          const endY = 768;
          const progress = interpolate(frame, [110, 185], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          });
          return (
            <g opacity={progress}>
              <line
                x1={startX}
                y1={startY}
                x2={endX}
                y2={startY - (startY - endY) * progress}
                stroke={COLORS.magpie}
                strokeWidth={3}
                strokeDasharray="6 4"
              />
            </g>
          );
        })()}
      </svg>

      {/* Left 3 Standalone Paradigm Cards */}
      {SOURCE_PILLARS.map((p) => {
        const cardAnim = fadeInUp(frame, p.delay, 32);
        return (
          <div
            key={p.name}
            style={{
              position: "absolute",
              left: p.x,
              top: p.y,
              width: 560,
              height: 170,
              borderRadius: 16,
              padding: "20px 24px",
              backgroundColor: COLORS.bgCard,
              border: `1px solid ${p.color}55`,
              boxShadow: `0 12px 32px rgba(0, 0, 0, 0.45), inset 0 1px 0 rgba(255,255,255,0.06)`,
              display: "flex",
              flexDirection: "column",
              justifyContent: "space-between",
              ...cardAnim,
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <div
                  style={{
                    width: 10,
                    height: 28,
                    borderRadius: 4,
                    backgroundColor: p.color,
                  }}
                />
                <span style={{ fontSize: 23, fontWeight: 700 }}>{p.name}</span>
              </div>
              <span
                style={{
                  fontFamily: FONT_MONO,
                  fontSize: 11,
                  fontWeight: 700,
                  padding: "4px 10px",
                  borderRadius: 6,
                  backgroundColor: `${p.color}20`,
                  color: p.color,
                  border: `1px solid ${p.color}44`,
                }}
              >
                {p.tag}
              </span>
            </div>
            <div
              style={{
                fontSize: 15,
                color: "#E2E8F0",
                lineHeight: 1.45,
                fontWeight: 500,
              }}
            >
              ✓ {p.strength}
            </div>
            <div
              style={{
                fontSize: 14,
                color: "#FDA4AF",
                lineHeight: 1.4,
                padding: "6px 10px",
                borderRadius: 8,
                backgroundColor: "rgba(244, 63, 94, 0.1)",
                border: "1px solid rgba(244, 63, 94, 0.22)",
              }}
            >
              ✕ {p.limitation}
            </div>
          </div>
        );
      })}

      {/* Right Agent_US Fused Core Reactor Card */}
      <div
        style={{
          position: "absolute",
          left: 1085,
          top: 342,
          width: 750,
          height: 498,
          borderRadius: 24,
          backgroundColor: "rgba(11, 20, 38, 0.94)",
          border: `1.5px solid rgba(16, 185, 129, ${0.4 + pulse * 0.35})`,
          boxShadow: `0 0 65px rgba(16, 185, 129, 0.18), 0 24px 60px rgba(0,0,0,0.6)`,
          padding: "32px 34px",
          transform: `scale(${interpolate(coreScale, [0, 1], [0.9, 1])})`,
          opacity: interpolate(coreScale, [0, 1], [0, 1]),
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <div>
            <div
              style={{
                fontFamily: FONT_MONO,
                fontSize: 13,
                color: COLORS.emeraldBright,
                letterSpacing: "0.14em",
                fontWeight: 700,
              }}
            >
              UNIFIED PRODUCTION CORE
            </div>
            <div style={{ fontSize: 38, fontWeight: 800, marginTop: 4 }}>
              Agent_US 融合架构引擎
            </div>
          </div>

          {/* Animated Reactor Ring */}
          <svg width={88} height={88} viewBox="0 0 88 88">
            <g transform={`rotate(${ringRotate} 44 44)`}>
              <circle
                cx={44}
                cy={44}
                r={36}
                fill="none"
                stroke={COLORS.cyan}
                strokeWidth={2.5}
                strokeDasharray="18 10"
              />
            </g>
            <g transform={`rotate(${-ringRotate * 1.4} 44 44)`}>
              <circle
                cx={44}
                cy={44}
                r={26}
                fill="none"
                stroke={COLORS.emeraldBright}
                strokeWidth={2.5}
                strokeDasharray="12 8"
              />
            </g>
            <circle cx={44} cy={44} r={10} fill={COLORS.emeraldBright} />
          </svg>
        </div>

        <div
          style={{
            fontSize: 17,
            color: COLORS.textSecondary,
            lineHeight: 1.55,
          }}
        >
          只保留 <strong style={{ color: COLORS.textPrimary }}>1 套主循环 (DSH)</strong> +{" "}
          <strong style={{ color: COLORS.textPrimary }}>1 套事务域事实源 (Task Engine)</strong> +{" "}
          <strong style={{ color: COLORS.textPrimary }}>1 套物理沙箱 (Docker + Codex PTY)</strong>
          ，实现真正可恢复、可并行、零逃逸的自治交付。
        </div>

        {/* 4 Capability Pills */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 14,
          }}
        >
          {FUSION_CHIPS.map((chip, idx) => {
            const p = springSnappy(frame, 125 + idx * 14);
            return (
              <div
                key={chip.label}
                style={{
                  padding: "14px 16px",
                  borderRadius: 12,
                  backgroundColor: "rgba(15, 23, 42, 0.9)",
                  border: `1px solid ${chip.color}50`,
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  opacity: p,
                  transform: `translateY(${(1 - p) * 18}px)`,
                }}
              >
                <div
                  style={{
                    width: 9,
                    height: 9,
                    borderRadius: 99,
                    backgroundColor: chip.color,
                    boxShadow: `0 0 10px ${chip.color}`,
                    flexShrink: 0,
                  }}
                />
                <span style={{ fontSize: 14, fontWeight: 600, whiteSpace: "nowrap" }}>
                  {chip.label}
                </span>
              </div>
            );
          })}
        </div>

        {/* Bottom SuperAgent + Magpie Badge */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            paddingTop: 14,
            borderTop: `1px solid ${COLORS.borderSubtle}`,
            fontFamily: FONT_MONO,
            fontSize: 13,
            color: COLORS.cyan,
          }}
        >
          <span>+ DeepSeek SuperAgent 领域状态机</span>
          <span style={{ color: COLORS.magpie }}>
            + Magpie v0.1.4490 本地网关
          </span>
        </div>
      </div>

      {/* Bottom Magpie Sidecar Chip */}
      <div
        style={{
          position: "absolute",
          left: 1110,
          top: 888,
          width: 700,
          height: 58,
          padding: "0 22px",
          borderRadius: 14,
          backgroundColor: "rgba(236, 72, 153, 0.12)",
          border: "1px solid rgba(236, 72, 153, 0.42)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 14,
          whiteSpace: "nowrap",
          ...fadeInUp(frame, 108, 20),
        }}
      >
        <span
          style={{
            fontFamily: FONT_MONO,
            fontSize: 12.5,
            fontWeight: 700,
            color: COLORS.magpie,
            flexShrink: 0,
          }}
        >
          SIDECAR GATEWAY
        </span>
        <span style={{ fontSize: 15, fontWeight: 600 }}>
          Magpie 127.0.0.1:3425 · AES-256-GCM 密钥库 · 原生通路毫秒级热备
        </span>
      </div>
    </div>
  );
};
