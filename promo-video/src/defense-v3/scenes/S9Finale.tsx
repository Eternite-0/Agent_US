import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { MONO, PAL, p, rise, spr } from "../theme";
import { BlueText, BrandEmblem } from "../components";

const FINAL_PILLS = [
  { v: "82.5%", k: "跨模块重构 Pass@1" },
  { v: "1.65×", k: "较主流子代理再提速" },
  { v: "-52%", k: "异构分级降本" },
  { v: "96.4%", k: "限流/强杀存活率" },
  { v: "T0 门禁", k: "账本防幻觉自愈" },
];

export const S9Finale: React.FC = () => {
  const f = useCurrentFrame();
  const s = spr(f, 8, 13, 115);
  const bar = p(f, 64, 46);

  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
      {[0, 1, 2, 3].map((i) => {
        const t = ((f + i * 44) % 176) / 176;
        return (
          <div
            key={i}
            style={{
              position: "absolute",
              width: 220 + t * 1440,
              height: 220 + t * 1440,
              borderRadius: 9999,
              border: `1.5px solid rgba(37,99,235,${0.24 * (1 - t)})`,
              marginTop: -90,
            }}
          />
        );
      })}

      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", marginTop: -16 }}>
        <div style={{ transform: `scale(${s})`, opacity: Math.min(1, s * 1.5) }}>
          <BrandEmblem size={152} float />
        </div>

        <div
          style={{
            ...rise(f, 22, 28, 28),
            fontSize: 120,
            fontWeight: 860,
            color: PAL.ink,
            marginTop: 30,
            letterSpacing: -2.5,
            lineHeight: 1,
          }}
        >
          Agent_<BlueText>US</BlueText>
        </div>

        <div
          style={{
            width: 620 * bar,
            height: 3.5,
            borderRadius: 4,
            background: `linear-gradient(90deg, transparent, ${PAL.blue}, transparent)`,
            marginTop: 22,
          }}
        />

        <div
          style={{
            ...rise(f, 52, 28, 20),
            fontSize: 42,
            fontWeight: 740,
            color: PAL.text,
            marginTop: 26,
            letterSpacing: 2,
          }}
        >
          让每一位开发者，都拥有一支 <BlueText>超越单点极限的 AI 工程军团</BlueText>
        </div>

        {/* Summary Competitiveness Strip */}
        <div style={{ display: "flex", gap: 16, marginTop: 36 }}>
          {FINAL_PILLS.map((it, idx) => (
            <div
              key={it.k}
              style={{
                ...rise(f, 78 + idx * 8, 24, 14),
                padding: "11px 22px",
                borderRadius: 16,
                background: "rgba(255,255,255,0.94)",
                border: `1.5px solid ${PAL.iceDeep}`,
                boxShadow: "0 14px 30px -18px rgba(22,66,190,0.40)",
                textAlign: "center",
              }}
            >
              <div style={{ fontFamily: MONO, fontSize: 24, fontWeight: 860, color: PAL.blue }}>{it.v}</div>
              <div style={{ fontSize: 13.5, fontWeight: 700, color: PAL.sub, marginTop: 3 }}>{it.k}</div>
            </div>
          ))}
        </div>

        <div
          style={{
            ...rise(f, 126, 28, 16),
            fontSize: 27,
            fontWeight: 650,
            color: PAL.sub,
            marginTop: 48,
            letterSpacing: 9,
          }}
        >
          感谢各位评委老师聆听 · 敬请批评指正
        </div>
      </div>
    </AbsoluteFill>
  );
};
