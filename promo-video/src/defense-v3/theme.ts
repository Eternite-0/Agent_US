import { Easing, interpolate, spring } from "remotion";

export const V3_FPS = 60;
export const V3_W = 1920;
export const V3_H = 1080;

export const PAL = {
  bg: "#F5F9FF",
  white: "#FFFFFF",
  ink: "#091730",
  text: "#1E293B",
  sub: "#51627C",
  muted: "#8B9BB4",
  line: "#E1EBF8",
  lineSoft: "#EDF3FC",
  chrome: "#F5F8FC",
  blue: "#2563EB",
  blueDeep: "#1642BE",
  blueMid: "#3B82F6",
  sky: "#60A5FA",
  cyan: "#0EA5E9",
  ice: "#EAF2FF",
  iceDeep: "#CFE2FF",
  green: "#0CA650",
  greenBg: "rgba(12, 166, 80, 0.10)",
  greenBorder: "rgba(12, 166, 80, 0.26)",
  red: "#DF3B37",
  redBg: "rgba(223, 59, 55, 0.09)",
  amber: "#D97706",
  amberBg: "rgba(217, 119, 6, 0.11)",
  amberBorder: "rgba(217, 119, 6, 0.30)",
  claude: "#D97757",
  codex: "#6366F1",
  hermes: "#475569",
};

export const FONT =
  '"Inter", "PingFang SC", "Microsoft YaHei", "Segoe UI", system-ui, sans-serif';
export const MONO = '"JetBrains Mono", "Cascadia Code", Consolas, monospace';

export const EASE_OUT = Easing.bezier(0.16, 1, 0.3, 1);
export const EASE_IO = Easing.bezier(0.65, 0, 0.35, 1);
export const EASE_SNAP = Easing.bezier(0.22, 1, 0.36, 1);
const CLAMP = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

export const p = (f: number, start: number, dur = 26, easing = EASE_OUT) =>
  interpolate(f, [start, start + dur], [0, 1], { ...CLAMP, easing });

export const mix = (t: number, a: number, b: number) => a + (b - a) * t;

export const spr = (f: number, delay = 0, damping = 15, stiffness = 130, mass = 0.88) =>
  spring({ frame: f - delay, fps: V3_FPS, config: { damping, stiffness, mass } });

export const rise = (f: number, start: number, dur = 28, dist = 28) => {
  const t = p(f, start, dur);
  return {
    opacity: t,
    transform: `translate3d(0, ${(1 - t) * dist}px, 0) scale(${0.97 + t * 0.03})`,
    filter: `blur(${(1 - t) * 5}px)`,
  } as const;
};

export const typed = (text: string, f: number, start: number, cpf = 0.45) =>
  text.slice(0, Math.min(text.length, Math.max(0, Math.floor((f - start) * cpf))));

export const countStr = (f: number, start: number, dur: number, target: number, decimals = 0) => {
  const val = target * p(f, start, dur, EASE_OUT);
  return decimals > 0 ? val.toFixed(decimals) : Math.round(val).toLocaleString("en-US");
};

export const V3_SCENES = [
  { key: "paradigm", dur: 660 },   // 0:00  - 0:11.0 (11.0s) ClaudeCode/Codex/Hermes Bottlenecks -> Agent_US
  { key: "kernel", dur: 780 },     // 0:11.0 - 0:24.0 (13.0s) 3 Core Proprietary Kernel Breakthroughs
  { key: "workbench", dur: 540 },  // 0:24.0 - 0:33.0 (9.0s)  1:1 Clean Workbench + Dynamic Camera Zoom
  { key: "router", dur: 1440 },    // 0:33.0 - 0:57.0 (24.0s) Router <-> Worker Live + Camera Focus Moves
  { key: "control", dur: 600 },    // 0:57.0 - 1:07.0 (10.0s) /compact /rewind /steer Control Primitives
  { key: "pool", dur: 720 },       // 1:07.0 - 1:19.0 (12.0s) Multi-Provider Pool + 0.28s Failover
  { key: "head2head", dur: 900 },  // 1:19.0 - 1:34.0 (15.0s) 6-Axis Radar + Matrix + Racing Benchmarks vs Claude/Codex/Hermes
  { key: "ecoarch", dur: 600 },    // 1:34.0 - 1:44.0 (10.0s) 3D 6-Layer Glass Architecture + 44-Plugin Ecosystem
  { key: "finale", dur: 360 },     // 1:44.0 - 1:50.0 (6.0s)  Grand Finale + Summary Metrics
] as const;

export const V3_TOTAL = V3_SCENES.reduce((acc, s) => acc + s.dur, 0); // 6600 frames = 110.0s
