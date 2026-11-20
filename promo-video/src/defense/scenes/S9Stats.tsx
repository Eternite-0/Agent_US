import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { C, EASE, prog, rise } from "../theme";
import { Blue, Icon, SceneTitle } from "../ui";

const STATS = [
  { icon: "terminal", v: 15, suf: "+", label: "原生工作区工具", d: "读写 · 补丁 · 终端 · 检索 · 子智能体" },
  { icon: "file", v: 42000, suf: "+", label: "行自研代码", d: "后端内核 + 桌面工作台" },
  { icon: "cube", v: 6, suf: "", label: "大能力中心", d: "对话 · 号池 · 模型 · 签到 · 定时 · 插件" },
  { icon: "lock", v: 256, suf: "-bit", label: "凭证加密强度", d: "AES-GCM 本地加密，密钥永不出端" },
  { icon: "edit", v: 4, suf: " 级", label: "模糊匹配编辑", d: "大模型改代码，一次命中" },
  { icon: "zap", v: 100, suf: "%", label: "本地运行", d: "数据与代码完全掌控在自己手中" },
];

export const S9Stats: React.FC = () => {
  const f = useCurrentFrame();
  return (
    <AbsoluteFill>
      <SceneTitle kicker="硬核数据" title={<>用数字说话</>} at={4} align="center" y={70} />
      <div
        style={{
          position: "absolute",
          top: 280,
          left: 150,
          right: 150,
          display: "grid",
          gridTemplateColumns: "repeat(3, 1fr)",
          gap: 34,
        }}
      >
        {STATS.map((s, i) => {
          const at = 30 + i * 12;
          const p = prog(f, at + 6, 80, EASE);
          const val = Math.round(s.v * p);
          return (
            <div
              key={s.label}
              style={{
                ...rise(f, at, 30, 40),
                height: 300,
                borderRadius: 28,
                background: "#fff",
                border: `1px solid ${C.line}`,
                boxShadow: "0 30px 60px -40px rgba(23,71,201,0.5)",
                padding: "36px 40px",
                position: "relative",
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  position: "absolute",
                  right: -40,
                  top: -40,
                  width: 180,
                  height: 180,
                  borderRadius: 999,
                  background: "radial-gradient(circle, rgba(96,165,250,0.22), rgba(96,165,250,0) 70%)",
                }}
              />
              <Icon name={s.icon} size={34} color={C.blue} />
              <div style={{ fontSize: 88, fontWeight: 800, letterSpacing: -2, marginTop: 14, lineHeight: 1 }}>
                <Blue>
                  {val.toLocaleString("en-US")}
                  {s.suf}
                </Blue>
              </div>
              <div style={{ fontSize: 28, fontWeight: 720, color: C.ink, marginTop: 16 }}>{s.label}</div>
              <div style={{ fontSize: 18, color: C.sub, marginTop: 8 }}>{s.d}</div>
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};
