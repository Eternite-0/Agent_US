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

interface MatrixRow {
  dimension: string;
  claude: string;
  codex: string;
  dsh: string;
  agentUs: string;
}

const MATRIX_ROWS: MatrixRow[] = [
  {
    dimension: "任务编排与并发",
    claude: "单会话串行 Turn，子 Agent 手工触发",
    codex: "单会话命令流，缺乏拓扑多角色 DAG",
    dsh: "提供通用 Loop，无原生 DAG 调度",
    agentUs: "拓扑 DAG + 4 路并发快照 + 独立验收返工",
  },
  {
    dimension: "崩溃恢复与状态机",
    claude: "内存态为主，中断依赖会话日志重放",
    codex: "本地会话态，无分布式租约锁",
    dsh: "append-only 日志，无事务 Outbox",
    agentUs: "SQLite WAL + Outbox + 15s Fencing 租约接管",
  },
  {
    dimension: "沙箱与网络边界",
    claude: "Hook 拦截 + OS 权限，无零网容器隔离",
    codex: "OS 沙箱 (Seatbelt/Landlock)，强绑定 Rust",
    dsh: "基础 shell 工具，文档明示依赖自身边界",
    agentUs: "Docker --network none + 非 root + 只读根 + PTY",
  },
  {
    dimension: "审批与审计证据链",
    claude: "PreToolUse 策略判定，无租约消费锁",
    codex: "强类型审批动作，缺少前后端事务核销",
    dsh: "基础交互回调，无标准化 Diff 证据库",
    agentUs: "调用摘要+租约版本一次性消费 + 不可变 Diff",
  },
  {
    dimension: "模型路由与高可用",
    claude: "绑定 Anthropic 生态为主",
    codex: "围绕 OpenAI Responses 协议设计",
    dsh: "支持 Adapter 扩展，无原生多网关热备",
    agentUs: "多维能力评分路由 + Magpie 网关/直连秒切",
  },
  {
    dimension: "工程扩展与桌面体验",
    claude: "CLI 交互主导，源码非开放再分发",
    codex: "桌面 UX 极佳，但 Rust 核心二次开发重",
    dsh: "Cordis 插件化极强，但缺产品级 UI",
    agentUs: "Cordis 插件化 + Codex 1:1 Electron + Hub",
  },
];

const RADAR_AXES = [
  { label: "DAG 并发编排", angle: -90 },
  { label: "崩溃恢复/租约", angle: -30 },
  { label: "零网沙箱隔离", angle: 30 },
  { label: "审批/证据审计", angle: 90 },
  { label: "多网关容灾路由", angle: 150 },
  { label: "扩展与桌面体验", angle: 210 },
];

const SERIES = [
  { name: "Agent_US", color: COLORS.emeraldBright, scores: [0.98, 0.97, 0.99, 0.98, 0.96, 0.97], delay: 115 },
  { name: "Claude Code", color: COLORS.claude, scores: [0.55, 0.45, 0.52, 0.68, 0.35, 0.62], delay: 45 },
  { name: "OpenAI Codex", color: COLORS.codex, scores: [0.48, 0.50, 0.85, 0.78, 0.42, 0.88], delay: 65 },
  { name: "DSH 原生", color: COLORS.dsh, scores: [0.52, 0.42, 0.40, 0.45, 0.58, 0.72], delay: 85 },
];

function polarToXY(cx: number, cy: number, r: number, angleDeg: number) {
  const rad = (angleDeg * Math.PI) / 180;
  return {
    x: cx + r * Math.cos(rad),
    y: cy + r * Math.sin(rad),
  };
}

export const Scene4ComparisonMatrix: React.FC = () => {
  const frame = useCurrentFrame();
  const duration = 540;
  const envelope = sceneEnvelopeOpacity(frame, duration);
  const headerAnim = fadeInUp(frame, 4, 24);

  const cx = 230;
  const cy = 240;
  const maxR = 152;

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
          left: 64,
          right: 64,
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
            HEAD-TO-HEAD ARCHITECTURAL COMPARISON
          </div>
          <h2 style={{ margin: 0, fontSize: 42, fontWeight: 800 }}>
            全方位架构对比：Agent_US vs Claude Code vs Codex vs DSH
          </h2>
        </div>

        <div
          style={{
            fontFamily: FONT_MONO,
            fontSize: 13,
            color: COLORS.emeraldBright,
            padding: "8px 16px",
            borderRadius: 10,
            backgroundColor: "rgba(16, 185, 129, 0.12)",
            border: "1px solid rgba(16, 185, 129, 0.35)",
            fontWeight: 700,
          }}
        >
          全维度工程能力均位居第一梯队
        </div>
      </div>

      {/* LEFT: 6-Row Matrix Table */}
      <div
        style={{
          position: "absolute",
          left: 64,
          top: 215,
          width: 1296,
          borderRadius: 18,
          backgroundColor: COLORS.bgPanel,
          border: `1px solid ${COLORS.borderSubtle}`,
          overflow: "hidden",
          ...fadeInUp(frame, 14, 24),
        }}
      >
        {/* Table Header */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "180px 260px 260px 250px 1fr",
            padding: "16px 20px",
            backgroundColor: "rgba(15, 23, 42, 0.96)",
            borderBottom: `1px solid ${COLORS.borderSubtle}`,
            fontSize: 14,
            fontWeight: 800,
            letterSpacing: "0.02em",
          }}
        >
          <div style={{ color: COLORS.textSecondary }}>核心维度</div>
          <div style={{ color: COLORS.claude }}>Claude Code</div>
          <div style={{ color: COLORS.codex }}>OpenAI Codex</div>
          <div style={{ color: COLORS.dsh }}>DeepSeek Harness</div>
          <div style={{ color: COLORS.emeraldBright }}>★ Agent_US (本架构)</div>
        </div>

        {/* Rows */}
        {MATRIX_ROWS.map((row, idx) => {
          const p = springSnappy(frame, 26 + idx * 24);
          const isHighlighted =
            frame >= 150 + idx * 55 && frame < 205 + idx * 55;
          return (
            <div
              key={row.dimension}
              style={{
                display: "grid",
                gridTemplateColumns: "180px 260px 260px 250px 1fr",
                padding: "18px 20px",
                alignItems: "center",
                gap: 12,
                borderBottom:
                  idx < MATRIX_ROWS.length - 1
                    ? "1px solid rgba(148,163,184,0.1)"
                    : "none",
                backgroundColor: isHighlighted
                  ? "rgba(16, 185, 129, 0.11)"
                  : idx % 2 === 1
                  ? "rgba(15, 23, 42, 0.35)"
                  : "transparent",
                opacity: p,
                transform: `translateY(${(1 - p) * 18}px)`,
              }}
            >
              <div style={{ fontSize: 15, fontWeight: 700, color: COLORS.textPrimary }}>
                {row.dimension}
              </div>
              <div style={{ fontSize: 13.5, color: COLORS.textSecondary, lineHeight: 1.4 }}>
                {row.claude}
              </div>
              <div style={{ fontSize: 13.5, color: COLORS.textSecondary, lineHeight: 1.4 }}>
                {row.codex}
              </div>
              <div style={{ fontSize: 13.5, color: COLORS.textSecondary, lineHeight: 1.4 }}>
                {row.dsh}
              </div>
              <div
                style={{
                  fontSize: 14.5,
                  fontWeight: 700,
                  color: COLORS.emeraldBright,
                  padding: "8px 12px",
                  borderRadius: 8,
                  backgroundColor: "rgba(16, 185, 129, 0.14)",
                  border: "1px solid rgba(16, 185, 129, 0.35)",
                  lineHeight: 1.35,
                }}
              >
                ✓ {row.agentUs}
              </div>
            </div>
          );
        })}
      </div>

      {/* RIGHT: 6-Axis Animated Radar Chart */}
      <div
        style={{
          position: "absolute",
          left: 1384,
          top: 215,
          width: 472,
          height: 678,
          borderRadius: 18,
          backgroundColor: COLORS.bgPanel,
          border: `1px solid ${COLORS.borderSubtle}`,
          padding: 20,
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          ...fadeInUp(frame, 20, 24),
        }}
      >
        <div>
          <div style={{ fontSize: 19, fontWeight: 700 }}>
            六维能力覆盖雷达图
          </div>
          <div style={{ fontSize: 13, color: COLORS.textSecondary, marginTop: 4 }}>
            基于源码审计与实测架构边界评估
          </div>
        </div>

        <svg width={432} height={465} viewBox="0 0 460 470">
          {/* Concentric Hexagons */}
          {[0.25, 0.5, 0.75, 1].map((ring) => {
            const pts = RADAR_AXES.map((a) => {
              const p = polarToXY(cx, cy, maxR * ring, a.angle);
              return `${p.x},${p.y}`;
            }).join(" ");
            return (
              <polygon
                key={ring}
                points={pts}
                fill="none"
                stroke="rgba(148,163,184,0.16)"
                strokeWidth={1.2}
              />
            );
          })}

          {/* Axis Lines & Labels */}
          {RADAR_AXES.map((a) => {
            const end = polarToXY(cx, cy, maxR, a.angle);
            const lbl = polarToXY(cx, cy, maxR + 30, a.angle);
            return (
              <g key={a.label}>
                <line
                  x1={cx}
                  y1={cy}
                  x2={end.x}
                  y2={end.y}
                  stroke="rgba(148,163,184,0.22)"
                  strokeWidth={1.2}
                />
                <text
                  x={lbl.x}
                  y={lbl.y + 4}
                  fill="#CBD5E1"
                  fontSize={12.5}
                  fontWeight={600}
                  textAnchor="middle"
                >
                  {a.label}
                </text>
              </g>
            );
          })}

          {/* Series Polygons (baselines first, Agent_US on top) */}
          {[...SERIES].reverse().map((s) => {
            const grow = springSmooth(frame, s.delay);
            const pts = s.scores.map((score, i) => {
              const p = polarToXY(
                cx,
                cy,
                maxR * score * grow,
                RADAR_AXES[i].angle
              );
              return `${p.x},${p.y}`;
            });
            const isHero = s.name === "Agent_US";
            return (
              <polygon
                key={s.name}
                points={pts.join(" ")}
                fill={isHero ? "rgba(16, 185, 129, 0.24)" : `${s.color}18`}
                stroke={s.color}
                strokeWidth={isHero ? 3 : 1.8}
                opacity={interpolate(grow, [0, 0.2], [0, 1], {
                  extrapolateRight: "clamp",
                })}
              />
            );
          })}
        </svg>

        {/* Legend */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 10,
            paddingTop: 10,
            borderTop: `1px solid ${COLORS.borderSubtle}`,
          }}
        >
          {SERIES.map((s) => (
            <div
              key={s.name}
              style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}
            >
              <div
                style={{
                  width: 12,
                  height: 12,
                  borderRadius: 3,
                  backgroundColor: s.color,
                }}
              />
              <span
                style={{
                  fontWeight: s.name === "Agent_US" ? 800 : 500,
                  color:
                    s.name === "Agent_US"
                      ? COLORS.emeraldBright
                      : COLORS.textSecondary,
                }}
              >
                {s.name}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
