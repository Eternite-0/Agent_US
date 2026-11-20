import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { C, prog, sp } from "../theme";
import { Blue, Icon, Logo, SceneTitle } from "../ui";

const NODES = [
  { icon: "plug", t: "MCP 工具枢纽", d: "Stdio 协议即插即用" },
  { icon: "puzzle", t: "插件与技能", d: "一键扩展专业能力" },
  { icon: "bot", t: "子智能体", d: "分工并行协作" },
  { icon: "clock", t: "定时任务", d: "无人值守自动执行" },
  { icon: "calendar", t: "签到中心", d: "协议桥接 + 本地插件" },
  { icon: "brain", t: "记忆中心", d: "跨会话长期记忆" },
  { icon: "chart", t: "用量与费用", d: "Token 成本可视化" },
  { icon: "branch", t: "Git 集成", d: "分支、提交、差异" },
];

const CX = 960;
const CY = 610;
const RX = 640;
const RY = 290;

export const S7Eco: React.FC = () => {
  const f = useCurrentFrame();
  const rot = f * 0.0016;
  const coreS = sp(f, 20, 14, 120);
  return (
    <AbsoluteFill>
      <SceneTitle kicker="开放生态" title={<>一个内核，<Blue>无限扩展</Blue></>} at={4} align="center" y={60} />
      <svg width={1920} height={1080} style={{ position: "absolute", inset: 0 }}>
        <ellipse
          cx={CX}
          cy={CY}
          rx={RX}
          ry={RY}
          fill="none"
          stroke={C.iceDeep}
          strokeWidth={2}
          strokeDasharray="6 10"
          opacity={prog(f, 30, 40)}
        />
        <ellipse cx={CX} cy={CY} rx={RX * 0.55} ry={RY * 0.55} fill="none" stroke={C.iceDeep} strokeWidth={1.5} opacity={prog(f, 40, 40) * 0.8} />
        {NODES.map((_, i) => {
          const a = (i / NODES.length) * Math.PI * 2 + rot - Math.PI / 2;
          const x = CX + Math.cos(a) * RX;
          const y = CY + Math.sin(a) * RY;
          const p = prog(f, 60 + i * 12, 30);
          const len = Math.hypot(x - CX, y - CY);
          return (
            <g key={i}>
              <line
                x1={CX}
                y1={CY}
                x2={x}
                y2={y}
                stroke={C.sky}
                strokeWidth={2}
                strokeDasharray={len}
                strokeDashoffset={len * (1 - p)}
                opacity={0.55}
              />
              {p >= 1 && (
                <circle
                  cx={CX + (x - CX) * (((f - 60 - i * 12) / 70) % 1)}
                  cy={CY + (y - CY) * (((f - 60 - i * 12) / 70) % 1)}
                  r={4.5}
                  fill={C.blue}
                />
              )}
            </g>
          );
        })}
      </svg>
      <div
        style={{
          position: "absolute",
          left: CX - 150,
          top: CY - 110,
          width: 300,
          height: 220,
          borderRadius: 40,
          background: "#fff",
          boxShadow: "0 40px 80px -30px rgba(23,71,201,0.5), 0 0 0 10px rgba(37,99,235,0.07)",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          transform: `scale(${coreS})`,
        }}
      >
        <Logo size={84} spin={f * 1.4} />
        <div style={{ fontSize: 26, fontWeight: 760, color: C.ink, marginTop: 16 }}>Direct Agent</div>
        <div style={{ fontSize: 17, color: C.sub, marginTop: 4 }}>多轮流式直连内核</div>
      </div>
      {NODES.map((n, i) => {
        const a = (i / NODES.length) * Math.PI * 2 + rot - Math.PI / 2;
        const x = CX + Math.cos(a) * RX;
        const y = CY + Math.sin(a) * RY;
        const s = sp(f, 70 + i * 12, 13, 140);
        return (
          <div
            key={n.t}
            style={{
              position: "absolute",
              left: x - 140,
              top: y - 42,
              width: 280,
              height: 84,
              borderRadius: 20,
              background: "#fff",
              border: `1px solid ${C.iceDeep}`,
              boxShadow: "0 20px 40px -24px rgba(23,71,201,0.45)",
              display: "flex",
              alignItems: "center",
              gap: 14,
              padding: "0 18px",
              transform: `scale(${s})`,
              opacity: Math.min(1, s * 1.5),
            }}
          >
            <div
              style={{
                width: 48,
                height: 48,
                borderRadius: 14,
                background: C.ice,
                display: "grid",
                placeItems: "center",
                flex: "none",
              }}
            >
              <Icon name={n.icon} size={26} color={C.blue} />
            </div>
            <div>
              <div style={{ fontSize: 21, fontWeight: 720, color: C.ink }}>{n.t}</div>
              <div style={{ fontSize: 15, color: C.sub, marginTop: 2 }}>{n.d}</div>
            </div>
          </div>
        );
      })}
    </AbsoluteFill>
  );
};
