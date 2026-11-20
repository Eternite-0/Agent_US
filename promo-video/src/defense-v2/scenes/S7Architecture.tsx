import React from "react";
import { AbsoluteFill, Img, useCurrentFrame } from "remotion";
import { EASE_OUT, MONO, PAL, p, rise } from "../theme";
import { BlueText, TitleBlock, asset } from "../components";

const LAYERS = [
  { id: "L6", name: "桌面交互层", tags: ["Electron 桌面壳", "React 19 工作台", "同源本地代理"] },
  { id: "L5", name: "流式总线层", tags: ["/v1 REST API", "SSE 全链路实时流", "事件与版本订阅"] },
  { id: "L4", name: "双模智能体内核", tags: ["Router DAG 编排", "Direct 多轮引擎", "4级模糊补丁诊断"], core: true },
  { id: "L3", name: "隔离能力层", tags: ["15+ 原生工程工具", "无网络隔离容器", "MCP Hub 枢纽"] },
  { id: "L2", name: "资源调度层", tags: ["AccountPool 号池", "模型元数据同步", "签到与定时服务"] },
  { id: "L1", name: "安全存储层", tags: ["SQLite WAL v4", "AES-256-GCM 金库", "JCS-SHA256 链式账本"] },
];

const METRICS = [
  { val: 42000, suf: "+", label: "行全栈自研代码" },
  { val: 5, suf: " 类", label: "专业 Worker 角色" },
  { val: 15, suf: "+", label: "原生工作区工具" },
  { val: 256, suf: "-bit", label: "本地凭证加密" },
  { val: 100, suf: "%", label: "本地可控可审计" },
];

export const S7Architecture: React.FC = () => {
  const f = useCurrentFrame();
  const stackIn = p(f, 16, 40);
  const dy = Math.sin(f / 32) * 7;
  // Smooth continuous scanner highlighting layers top -> bottom
  const scanIdx = f > 120 ? Math.floor(((f - 120) / 48) % LAYERS.length) : -1;

  return (
    <AbsoluteFill>
      <TitleBlock
        kicker="全栈自研架构"
        title={
          <>
            六层解耦，<BlueText>为工程级可靠而生</BlueText>
          </>
        }
        at={4}
        align="left"
        x={96}
        y={48}
        width={1200}
        size={52}
      />

      {/* LEFT: Bespoke 3D 6-Layer Frosted Glass Stack inside matching elevated white glass frame */}
      <div
        style={{
          position: "absolute",
          left: 96,
          top: 196,
          width: 684,
          height: 622,
          borderRadius: 30,
          background: "#FFFFFF",
          border: `1.5px solid ${PAL.line}`,
          boxShadow: "0 30px 70px -36px rgba(23,69,196,0.30)",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          padding: "24px 28px 20px",
          opacity: stackIn,
          transform: `translateY(${(1 - stackIn) * 28}px) scale(${0.94 + stackIn * 0.06})`,
          overflow: "hidden",
        }}
      >
        <Img
          src={asset("visuals/arch-3d.jpg")}
          style={{
            width: "92%",
            height: "86%",
            objectFit: "contain",
            transform: `translateY(${dy}px)`,
          }}
        />
        <div
          style={{
            marginTop: 8,
            display: "flex",
            alignItems: "center",
            gap: 10,
            fontSize: 15,
            fontWeight: 700,
            color: PAL.blueDeep,
            letterSpacing: 1.5,
          }}
        >
          <span style={{ width: 8, height: 8, borderRadius: 99, background: PAL.blue }} />
          SIX-LAYER DECOUPLED FULL-STACK ARCHITECTURE
        </div>
      </div>

      {/* RIGHT: 6 Illuminated Architectural Layer Cards */}
      <div
        style={{
          position: "absolute",
          left: 816,
          top: 196,
          width: 1008,
          display: "flex",
          flexDirection: "column",
          gap: 14,
        }}
      >
        {LAYERS.map((layer, i) => {
          const at = 26 + i * 16;
          const pr = p(f, at, 28);
          const lit = scanIdx === i || (scanIdx === -1 && layer.core && f > 80);
          return (
            <div
              key={layer.id}
              style={{
                height: 92,
                borderRadius: 20,
                padding: "0 26px",
                background: lit
                  ? `linear-gradient(100deg, ${PAL.ice} 0%, #FFFFFF 100%)`
                  : "rgba(255,255,255,0.94)",
                border: `1.6px solid ${lit ? PAL.blueMid : PAL.line}`,
                boxShadow: lit
                  ? "0 20px 44px -24px rgba(37,99,235,0.45)"
                  : "0 14px 32px -26px rgba(10,25,53,0.22)",
                display: "flex",
                alignItems: "center",
                gap: 20,
                opacity: pr,
                transform: `translateX(${(1 - pr) * 60}px)`,
              }}
            >
              <span
                style={{
                  width: 48,
                  height: 48,
                  borderRadius: 14,
                  background: layer.core || lit ? `linear-gradient(135deg, ${PAL.blueMid}, ${PAL.blueDeep})` : PAL.ice,
                  color: layer.core || lit ? "#FFFFFF" : PAL.blue,
                  display: "grid",
                  placeItems: "center",
                  fontFamily: MONO,
                  fontSize: 17,
                  fontWeight: 800,
                  flex: "none",
                }}
              >
                {layer.id}
              </span>
              <div style={{ width: 190, fontSize: 23, fontWeight: 800, color: PAL.ink }}>{layer.name}</div>
              <div style={{ display: "flex", gap: 10, flex: 1 }}>
                {layer.tags.map((tag, k) => (
                  <span
                    key={tag}
                    style={{
                      opacity: p(f, at + 8 + k * 5, 18),
                      padding: "8px 14px",
                      borderRadius: 11,
                      background: PAL.chrome,
                      border: `1px solid ${PAL.lineSoft}`,
                      fontSize: 16,
                      fontWeight: 620,
                      color: PAL.text,
                      fontFamily: /^[A-Za-z/]/.test(tag) ? MONO : undefined,
                      whiteSpace: "nowrap",
                    }}
                  >
                    {tag}
                  </span>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {/* BOTTOM: Hard Engineering Scale Strip */}
      <div
        style={{
          position: "absolute",
          left: 96,
          right: 96,
          bottom: 54,
          display: "grid",
          gridTemplateColumns: "repeat(5, 1fr)",
          gap: 20,
        }}
      >
        {METRICS.map((m, i) => {
          const at = 140 + i * 10;
          const cnt = Math.round(m.val * p(f, at, 70, EASE_OUT));
          return (
            <div
              key={m.label}
              style={{
                ...rise(f, at, 26, 20),
                padding: "18px 22px",
                borderRadius: 20,
                background: "rgba(255,255,255,0.95)",
                border: `1.5px solid ${PAL.iceDeep}`,
                boxShadow: "0 18px 40px -28px rgba(23,69,196,0.38)",
                textAlign: "center",
              }}
            >
              <div style={{ fontSize: 40, fontWeight: 850, letterSpacing: -1.2, lineHeight: 1.05 }}>
                <BlueText>
                  {cnt.toLocaleString("en-US")}
                  {m.suf}
                </BlueText>
              </div>
              <div style={{ fontSize: 16.5, fontWeight: 700, color: PAL.sub, marginTop: 6 }}>{m.label}</div>
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};
