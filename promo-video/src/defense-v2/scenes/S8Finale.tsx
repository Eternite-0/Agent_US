import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { PAL, p, rise, spr } from "../theme";
import { BlueText, BrandEmblem } from "../components";

export const S8Finale: React.FC = () => {
  const f = useCurrentFrame();
  const s = spr(f, 8, 13, 110);
  const bar = p(f, 68, 48);

  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
      {[0, 1, 2, 3].map((i) => {
        const t = ((f + i * 44) % 176) / 176;
        return (
          <div
            key={i}
            style={{
              position: "absolute",
              width: 220 + t * 1420,
              height: 220 + t * 1420,
              borderRadius: 9999,
              border: `1.5px solid rgba(37,99,235,${0.24 * (1 - t)})`,
              marginTop: -110,
            }}
          />
        );
      })}

      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", marginTop: -24 }}>
        <div style={{ transform: `scale(${s})`, opacity: Math.min(1, s * 1.5) }}>
          <BrandEmblem size={156} float />
        </div>

        <div
          style={{
            ...rise(f, 24, 30, 28),
            fontSize: 124,
            fontWeight: 850,
            color: PAL.ink,
            marginTop: 34,
            letterSpacing: -2.5,
            lineHeight: 1,
          }}
        >
          Agent_<BlueText>US</BlueText>
        </div>

        <div
          style={{
            width: 580 * bar,
            height: 3.5,
            borderRadius: 4,
            background: `linear-gradient(90deg, transparent, ${PAL.blue}, transparent)`,
            marginTop: 26,
          }}
        />

        <div
          style={{
            ...rise(f, 58, 30, 20),
            fontSize: 44,
            fontWeight: 720,
            color: PAL.text,
            marginTop: 32,
            letterSpacing: 2.5,
          }}
        >
          让每一位开发者，都拥有一支 <BlueText>自主协同的 AI 工程军团</BlueText>
        </div>

        <div
          style={{
            ...rise(f, 108, 30, 16),
            fontSize: 28,
            fontWeight: 600,
            color: PAL.sub,
            marginTop: 58,
            letterSpacing: 9,
          }}
        >
          感谢各位评委老师聆听 · 敬请批评指正
        </div>
      </div>
    </AbsoluteFill>
  );
};
