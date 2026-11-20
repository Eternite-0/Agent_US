import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { C, prog, rise, sp } from "../theme";
import { Blue, Logo } from "../ui";

export const S10Finale: React.FC = () => {
  const f = useCurrentFrame();
  const s = sp(f, 6, 14, 110);
  const line = prog(f, 70, 50);
  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
      {[0, 1, 2, 3].map((i) => {
        const t = ((f + i * 45) % 180) / 180;
        return (
          <div
            key={i}
            style={{
              position: "absolute",
              width: 200 + t * 1400,
              height: 200 + t * 1400,
              borderRadius: 9999,
              border: `1.5px solid rgba(37,99,235,${0.22 * (1 - t)})`,
              marginTop: -150,
            }}
          />
        );
      })}
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", marginTop: -40 }}>
        <div style={{ transform: `scale(${s})` }}>
          <Logo size={120} spin={f * 1.4} />
        </div>
        <div style={{ ...rise(f, 24, 30, 30), fontSize: 120, fontWeight: 800, color: C.ink, marginTop: 34, letterSpacing: -2 }}>
          Agent_<Blue>US</Blue>
        </div>
        <div style={{ width: 520 * line, height: 3, borderRadius: 3, background: `linear-gradient(90deg, transparent, ${C.blue}, transparent)`, marginTop: 20 }} />
        <div style={{ ...rise(f, 60, 30), fontSize: 46, fontWeight: 650, color: C.text, marginTop: 30, letterSpacing: 3 }}>
          让每一位开发者，都拥有一支 <Blue>AI 工程团队</Blue>
        </div>
        <div style={{ ...rise(f, 110, 30), fontSize: 30, color: C.sub, marginTop: 64, letterSpacing: 10 }}>感谢聆听 · 敬请指正</div>
      </div>
    </AbsoluteFill>
  );
};
