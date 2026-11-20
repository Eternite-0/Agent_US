import { Easing, interpolate, spring } from "remotion";

export const V2_FPS = 60;
export const V2_W = 1920;
export const V2_H = 1080;

export const PAL = {
  bg: "#F6F9FF",
  white: "#FFFFFF",
  ink: "#0A1935",
  text: "#1E293B",
  sub: "#52637D",
  muted: "#8C9CB5",
  line: "#E2EBF8",
  lineSoft: "#EEF4FC",
  chrome: "#F4F7FC",
  blue: "#2563EB",
  blueDeep: "#1745C4",
  blueMid: "#3B82F6",
  sky: "#60A5FA",
  cyan: "#0EA5E9",
  ice: "#EAF2FF",
  iceDeep: "#D3E4FF",
  green: "#0EA452",
  greenBg: "rgba(14, 164, 82, 0.10)",
  greenBorder: "rgba(14, 164, 82, 0.25)",
  red: "#DF3B37",
  redBg: "rgba(223, 59, 55, 0.09)",
  amber: "#D97706",
  amberBg: "rgba(217, 119, 6, 0.11)",
  amberBorder: "rgba(217, 119, 6, 0.30)",
};

export const FONT =
  '"Inter", "PingFang SC", "Microsoft YaHei", "Segoe UI", system-ui, sans-serif';
export const MONO = '"JetBrains Mono", "Cascadia Code", Consolas, monospace';

export const EASE_OUT = Easing.bezier(0.22, 1, 0.36, 1);
export const EASE_IO = Easing.bezier(0.65, 0, 0.35, 1);
const CLAMP = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

export const p = (f: number, start: number, dur = 26, easing = EASE_OUT) =>
  interpolate(f, [start, start + dur], [0, 1], { ...CLAMP, easing });

export const mix = (t: number, a: number, b: number) => a + (b - a) * t;

export const spr = (f: number, delay = 0, damping = 16, stiffness = 125, mass = 0.9) =>
  spring({ frame: f - delay, fps: V2_FPS, config: { damping, stiffness, mass } });

export const rise = (f: number, start: number, dur = 28, dist = 26) => {
  const t = p(f, start, dur);
  return {
    opacity: t,
    transform: `translateY(${(1 - t) * dist}px)`,
    filter: `blur(${(1 - t) * 5}px)`,
  } as const;
};

export const typed = (text: string, f: number, start: number, cpf = 0.45) =>
  text.slice(0, Math.min(text.length, Math.max(0, Math.floor((f - start) * cpf))));

export const V2_SCENES = [
  { key: "paradigm", dur: 690 },   // 0:00 - 0:11.5  (11.5s) ClaudeCode/Codex/Hermes -> Agent_US
  { key: "workbench", dur: 600 },  // 0:11.5 - 0:21.5 (10.0s) Real-styled Desktop Workbench
  { key: "router", dur: 1560 },    // 0:21.5 - 0:47.5 (26.0s) Router <-> Worker Live Orchestration
  { key: "control", dur: 660 },    // 0:47.5 - 0:58.5 (11.0s) /compact /rewind /steer (3D glass)
  { key: "pool", dur: 840 },       // 0:58.5 - 1:12.5 (14.0s) Multi-Provider Pool + 429 Failover + Checkin
  { key: "eco", dur: 600 },        // 1:12.5 - 1:22.5 (10.0s) 44 Real Plugin Logos + MCP Hub
  { key: "arch", dur: 480 },       // 1:22.5 - 1:30.5 (8.0s)  3D 6-Layer Glass Architecture + Metrics
  { key: "finale", dur: 330 },     // 1:30.5 - 1:36.0 (5.5s)  Brand Finale
] as const;

export const V2_TOTAL = V2_SCENES.reduce((acc, s) => acc + s.dur, 0);
