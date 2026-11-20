import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { C, MONO, prog, rise } from "../theme";
import { Blue, Icon, SceneTitle } from "../ui";

const LAYERS = [
  { icon: "desktop", name: "交互层", mods: ["Electron 桌面端", "React 工作台", "同源代理"] },
  { icon: "zap", name: "接口层", mods: ["/v1 REST", "SSE 实时流", "会话与事件总线"] },
  { icon: "bot", name: "智能体内核", mods: ["DirectAgentRuntime", "上下文与 Hooks", "补丁与诊断"] },
  { icon: "layers", name: "能力层", mods: ["工作区工具链 ×15", "MCP Hub", "子智能体调度"] },
  { icon: "pool", name: "资源层", mods: ["AccountPool 号池", "模型管理", "签到服务"] },
  { icon: "db", name: "存储与安全", mods: ["SQLite WAL", "AES-256-GCM Vault", "确定性快照"] },
];

const TOP = 170;
const LH = 112;
const GAP = 16;
const LEFT = 820;
const W = 1000;

export const S8Arch: React.FC = () => {
  const f = useCurrentFrame();
  const total = LAYERS.length * (LH + GAP) - GAP;
  const pulseT = ((f - 140) / 120) % 1;
  return (
    <AbsoluteFill>
      <SceneTitle
        kicker="系统架构"
        title={
          <>
            六层解耦
            <br />
            <Blue>全栈自研</Blue>
          </>
        }
        desc={"从桌面交互到加密存储，\n每一层都为「可控、可靠、可扩展」而设计。"}
        at={4}
        x={120}
        y={330}
        width={620}
      />
      <div style={{ position: "absolute", left: 120, top: 700, display: "flex", gap: 30, ...rise(f, 60, 30) }}>
        {[
          ["Node.js 24", "Fastify"],
          ["React", "TypeScript"],
          ["SQLite", "WAL"],
        ].map(([a, b]) => (
          <div key={a} style={{ fontFamily: MONO, fontSize: 18, color: C.sub }}>
            <div style={{ color: C.blueDeep, fontWeight: 700, fontSize: 21 }}>{a}</div>
            {b}
          </div>
        ))}
      </div>
      <div style={{ position: "absolute", left: LEFT - 34, top: TOP, width: 4, height: total, borderRadius: 4, background: C.lineSoft }}>
        <div
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            width: 4,
            height: total * prog(f, 30, 120),
            borderRadius: 4,
            background: `linear-gradient(${C.sky}, ${C.blue})`,
          }}
        />
        {f > 140 && (
          <div
            style={{
              position: "absolute",
              left: -6,
              top: pulseT * total - 8,
              width: 16,
              height: 16,
              borderRadius: 99,
              background: C.blue,
              boxShadow: "0 0 0 8px rgba(37,99,235,0.18)",
            }}
          />
        )}
      </div>
      {LAYERS.map((l, i) => {
        const at = 30 + i * 18;
        const p = prog(f, at, 30);
        const lit = f > 140 && Math.abs(pulseT * total - (i * (LH + GAP) + LH / 2)) < LH / 2;
        return (
          <div
            key={l.name}
            style={{
              position: "absolute",
              left: LEFT,
              top: TOP + i * (LH + GAP),
              width: W,
              height: LH,
              borderRadius: 22,
              background: lit ? `linear-gradient(100deg, ${C.ice}, #fff)` : "#fff",
              border: `1.5px solid ${lit ? C.sky : C.line}`,
              boxShadow: "0 18px 40px -30px rgba(23,71,201,0.5)",
              display: "flex",
              alignItems: "center",
              padding: "0 28px",
              gap: 22,
              opacity: p,
              transform: `translateX(${(1 - p) * 80}px)`,
            }}
          >
            <div
              style={{
                width: 56,
                height: 56,
                borderRadius: 16,
                background: i === 2 ? `linear-gradient(140deg, ${C.blueMid}, ${C.blueDeep})` : C.ice,
                display: "grid",
                placeItems: "center",
                flex: "none",
              }}
            >
              <Icon name={l.icon} size={28} color={i === 2 ? "#fff" : C.blue} />
            </div>
            <div style={{ width: 170, fontSize: 26, fontWeight: 760, color: C.ink }}>{l.name}</div>
            <div style={{ display: "flex", gap: 12, flex: 1 }}>
              {l.mods.map((m, k) => (
                <span
                  key={m}
                  style={{
                    opacity: prog(f, at + 10 + k * 6, 20),
                    padding: "10px 16px",
                    borderRadius: 12,
                    background: C.chrome,
                    border: `1px solid ${C.lineSoft}`,
                    fontSize: 18,
                    fontWeight: 560,
                    color: C.text,
                    fontFamily: /[A-Za-z]/.test(m[0]) || m.startsWith("/") ? MONO : undefined,
                  }}
                >
                  {m}
                </span>
              ))}
            </div>
          </div>
        );
      })}
    </AbsoluteFill>
  );
};
