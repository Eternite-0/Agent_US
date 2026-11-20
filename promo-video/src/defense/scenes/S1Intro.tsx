import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { C, prog, rise, sp } from "../theme";
import { Blue, Logo } from "../ui";

export const S1Intro: React.FC = () => {
  const f = useCurrentFrame();
  const s = sp(f, 8, 13, 110);
  const rings = [0, 1, 2];
  const title = "Agent_US";
  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
      {rings.map((i) => {
        const p = prog(f, 10 + i * 10, 90);
        return (
          <div
            key={i}
            style={{
              position: "absolute",
              width: 260 + p * (520 + i * 260),
              height: 260 + p * (520 + i * 260),
              borderRadius: 9999,
              border: `1.5px solid rgba(37,99,235,${0.28 * (1 - p * 0.75)})`,
            }}
          />
        );
      })}
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", marginTop: -40 }}>
        <div style={{ transform: `scale(${s}) rotate(${(1 - s) * -30}deg)`, opacity: Math.min(1, s * 2) }}>
          <Logo size={150} spin={f * 1.4} />
        </div>
        <div style={{ display: "flex", marginTop: 46, fontSize: 132, fontWeight: 800, letterSpacing: -2, color: C.ink }}>
          {title.split("").map((ch, i) => {
            const p = prog(f, 34 + i * 4, 30);
            return (
              <span
                key={i}
                style={{
                  opacity: p,
                  transform: `translateY(${(1 - p) * 50}px)`,
                  filter: `blur(${(1 - p) * 10}px)`,
                  display: "inline-block",
                  color: ch === "U" || ch === "S" ? C.blue : C.ink,
                }}
              >
                {ch}
              </span>
            );
          })}
        </div>
        <div style={{ ...rise(f, 82, 30), marginTop: 18, fontSize: 40, fontWeight: 600, color: C.text, letterSpacing: 4 }}>
          新一代 <Blue>本地多模型自主编程智能体</Blue> 工作台
        </div>
        <div
          style={{
            ...rise(f, 104, 30),
            marginTop: 30,
            display: "flex",
            gap: 16,
          }}
        >
          {["多轮流式直连内核", "多供应商号池网关", "全链路可控可回溯"].map((t, i) => (
            <span
              key={t}
              style={{
                ...rise(f, 110 + i * 8, 26, 12),
                padding: "10px 22px",
                borderRadius: 999,
                background: "#fff",
                border: `1px solid ${C.iceDeep}`,
                color: C.blueDeep,
                fontSize: 22,
                fontWeight: 600,
                boxShadow: "0 10px 24px -14px rgba(23,71,201,0.4)",
              }}
            >
              {t}
            </span>
          ))}
        </div>
      </div>
      <div
        style={{
          position: "absolute",
          bottom: 70,
          fontSize: 18,
          letterSpacing: 8,
          color: C.muted,
          opacity: interpolate(f, [140, 170], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
        }}
      >
        PROJECT DEFENSE · 2026
      </div>
    </AbsoluteFill>
  );
};
