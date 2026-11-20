import React from "react";
import { interpolate, useCurrentFrame } from "remotion";
import {
  COLORS,
  FONT_MONO,
  FONT_SANS,
  FPS,
  HEIGHT,
  SCENE_RANGES,
  TOTAL_FRAMES,
  WIDTH,
} from "../theme";

export const HudChrome: React.FC = () => {
  const frame = useCurrentFrame();

  const currentScene =
    SCENE_RANGES.find(
      (s) => frame >= s.start && frame < s.start + s.duration
    ) ?? SCENE_RANGES[SCENE_RANGES.length - 1];

  const seconds = (frame / FPS).toFixed(2).padStart(5, "0");
  const totalSeconds = (TOTAL_FRAMES / FPS).toFixed(0);
  const gridOffset = (frame * 0.45) % 64;
  const pulseGlow = 0.55 + 0.45 * Math.sin(frame * 0.08);
  const scanY = interpolate(frame % 240, [0, 240], [-120, HEIGHT + 120]);

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        width: WIDTH,
        height: HEIGHT,
        pointerEvents: "none",
        fontFamily: FONT_SANS,
        overflow: "hidden",
      }}
    >
      {/* Ambient Deep Engineering Backdrop */}
      <svg
        width={WIDTH}
        height={HEIGHT}
        style={{ position: "absolute", inset: 0, zIndex: 0 }}
      >
        <defs>
          <radialGradient id="glowTL" cx="18%" cy="15%" r="55%">
            <stop offset="0%" stopColor="rgba(56, 189, 248, 0.14)" />
            <stop offset="100%" stopColor="rgba(5, 8, 17, 0)" />
          </radialGradient>
          <radialGradient id="glowBR" cx="85%" cy="85%" r="55%">
            <stop offset="0%" stopColor="rgba(16, 185, 129, 0.12)" />
            <stop offset="100%" stopColor="rgba(5, 8, 17, 0)" />
          </radialGradient>
          <radialGradient id="glowCenter" cx="50%" cy="50%" r="48%">
            <stop offset="0%" stopColor="rgba(129, 140, 248, 0.08)" />
            <stop offset="100%" stopColor="rgba(5, 8, 17, 0)" />
          </radialGradient>
          <pattern
            id="engGrid"
            width={64}
            height={64}
            patternUnits="userSpaceOnUse"
            patternTransform={`translate(${gridOffset}, ${gridOffset * 0.5})`}
          >
            <path
              d="M 64 0 L 0 0 0 64"
              fill="none"
              stroke="rgba(148, 163, 184, 0.06)"
              strokeWidth={1}
            />
            <circle cx={0} cy={0} r={1.2} fill="rgba(56, 189, 248, 0.18)" />
          </pattern>
        </defs>
        <rect width={WIDTH} height={HEIGHT} fill={COLORS.bgDeep} />
        <rect width={WIDTH} height={HEIGHT} fill="url(#engGrid)" />
        <rect width={WIDTH} height={HEIGHT} fill="url(#glowTL)" />
        <rect width={WIDTH} height={HEIGHT} fill="url(#glowBR)" />
        <rect width={WIDTH} height={HEIGHT} fill="url(#glowCenter)" />
        <line
          x1={0}
          y1={scanY}
          x2={WIDTH}
          y2={scanY}
          stroke="rgba(56, 189, 248, 0.07)"
          strokeWidth={2}
        />
      </svg>

      {/* Top Architectural HUD Bar */}
      <div
        style={{
          position: "absolute",
          top: 22,
          left: 44,
          right: 44,
          height: 52,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 22px",
          borderRadius: 14,
          backgroundColor: "rgba(10, 16, 30, 0.78)",
          border: `1px solid ${COLORS.borderSubtle}`,
          backdropFilter: "blur(12px)",
          zIndex: 50,
        }}
      >
        {/* Left Brand & Module Indicator */}
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div
            style={{
              width: 12,
              height: 12,
              borderRadius: 99,
              backgroundColor: COLORS.emeraldBright,
              boxShadow: `0 0 ${10 + pulseGlow * 8}px ${COLORS.emerald}`,
            }}
          />
          <span
            style={{
              fontFamily: FONT_MONO,
              fontWeight: 700,
              fontSize: 18,
              letterSpacing: "0.08em",
              color: COLORS.textPrimary,
            }}
          >
            AGENT_US
          </span>
          <span
            style={{
              fontSize: 13,
              padding: "3px 10px",
              borderRadius: 6,
              backgroundColor: "rgba(56, 189, 248, 0.12)",
              border: "1px solid rgba(56, 189, 248, 0.28)",
              color: COLORS.cyan,
              fontFamily: FONT_MONO,
            }}
          >
            DSH · CODEX · CLAUDE · MAGPIE
          </span>
        </div>

        {/* Center Active Scene Chapter */}
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span
            style={{
              fontFamily: FONT_MONO,
              fontSize: 12,
              letterSpacing: "0.14em",
              color: COLORS.cyan,
              fontWeight: 600,
            }}
          >
            {currentScene.en}
          </span>
          <span style={{ color: COLORS.textMuted }}>|</span>
          <span
            style={{
              fontSize: 15,
              fontWeight: 600,
              color: COLORS.textPrimary,
            }}
          >
            {currentScene.label}
          </span>
        </div>

        {/* Right Telemetry Timecode */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 16,
            fontFamily: FONT_MONO,
            fontSize: 13,
            color: COLORS.textSecondary,
          }}
        >
          <span>
            FRAME{" "}
            <strong style={{ color: COLORS.textPrimary }}>
              {String(frame).padStart(4, "0")}
            </strong>
            /{TOTAL_FRAMES}
          </span>
          <span>
            <strong style={{ color: COLORS.emeraldBright }}>{seconds}s</strong> /{" "}
            {totalSeconds}s
          </span>
          <span
            style={{
              padding: "2px 8px",
              borderRadius: 5,
              backgroundColor: "rgba(16, 185, 129, 0.15)",
              color: COLORS.emeraldBright,
              border: "1px solid rgba(16, 185, 129, 0.35)",
              fontSize: 12,
              fontWeight: 700,
            }}
          >
            60 FPS · 1080P
          </span>
        </div>
      </div>

      {/* Bottom 6-Chapter Progress Timeline */}
      <div
        style={{
          position: "absolute",
          bottom: 20,
          left: 44,
          right: 44,
          height: 36,
          display: "flex",
          alignItems: "center",
          gap: 10,
          zIndex: 50,
        }}
      >
        {SCENE_RANGES.map((scene) => {
          const isActive =
            frame >= scene.start && frame < scene.start + scene.duration;
          const progress = interpolate(
            frame,
            [scene.start, scene.start + scene.duration],
            [0, 1],
            { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
          );
          return (
            <div
              key={scene.id}
              style={{
                flex: scene.duration,
                display: "flex",
                flexDirection: "column",
                gap: 5,
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  fontSize: 11,
                  fontFamily: FONT_MONO,
                  color: isActive ? COLORS.textPrimary : COLORS.textMuted,
                  fontWeight: isActive ? 700 : 500,
                }}
              >
                <span>{scene.label}</span>
              </div>
              <div
                style={{
                  height: 5,
                  borderRadius: 99,
                  backgroundColor: "rgba(148, 163, 184, 0.16)",
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    width: `${progress * 100}%`,
                    height: "100%",
                    borderRadius: 99,
                    background: isActive
                      ? `linear-gradient(90deg, ${COLORS.cyan}, ${COLORS.emeraldBright})`
                      : "rgba(56, 189, 248, 0.5)",
                  }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
