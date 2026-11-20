import { Easing, interpolate, spring } from "remotion";

export const D_FPS = 60;
export const D_W = 1920;
export const D_H = 1080;

export const C = {
  bg: "#F6F9FF",
  white: "#FFFFFF",
  ink: "#0B1B3A",
  text: "#1E293B",
  sub: "#52627A",
  muted: "#94A3B8",
  line: "#E3EAF5",
  lineSoft: "#EEF3FA",
  blue: "#2563EB",
  blueDeep: "#1747C9",
  blueMid: "#3B82F6",
  sky: "#60A5FA",
  ice: "#EAF2FF",
  iceDeep: "#D6E6FF",
  green: "#12A150",
  greenSoft: "rgba(18,161,80,0.10)",
  red: "#E03E3A",
  redSoft: "rgba(224,62,58,0.09)",
  amber: "#E58A17",
  amberSoft: "rgba(229,138,23,0.12)",
  chrome: "#F3F6FB",
};

export const FONT =
  '"Inter", "Segoe UI", "Microsoft YaHei", "PingFang SC", system-ui, sans-serif';
export const MONO = '"JetBrains Mono", "Cascadia Code", Consolas, monospace';

export const EASE = Easing.bezier(0.22, 1, 0.36, 1);
export const EASE_IO = Easing.bezier(0.65, 0, 0.35, 1);

const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

/** 0→1 eased progress between start and start+dur */
export const prog = (f: number, start: number, dur = 24, easing = EASE) =>
  interpolate(f, [start, start + dur], [0, 1], { ...clamp, easing });

export const lerp = (p: number, a: number, b: number) => a + (b - a) * p;

export const sp = (f: number, delay = 0, damping = 18, stiffness = 120, mass = 0.9) =>
  spring({ frame: f - delay, fps: D_FPS, config: { damping, stiffness, mass } });

/** Reveal a string progressively, chars per frame */
export const typed = (text: string, f: number, start: number, cpf = 0.6) => {
  const n = Math.max(0, Math.floor((f - start) * cpf));
  return text.slice(0, Math.min(text.length, n));
};

export const rise = (f: number, start: number, dur = 26, dist = 24) => {
  const p = prog(f, start, dur);
  return {
    opacity: p,
    transform: `translateY(${(1 - p) * dist}px)`,
    filter: `blur(${(1 - p) * 6}px)`,
  } as const;
};

export const pop = (f: number, start: number) => {
  const s = sp(f, start, 14, 140);
  return {
    opacity: Math.min(1, s * 1.4),
    transform: `scale(${0.6 + s * 0.4})`,
  } as const;
};

export const SCENES = [
  { key: "intro", dur: 300 },
  { key: "vision", dur: 330 },
  { key: "home", dur: 540 },
  { key: "agent", dur: 1140 },
  { key: "control", dur: 660 },
  { key: "pool", dur: 720 },
  { key: "eco", dur: 540 },
  { key: "arch", dur: 540 },
  { key: "stats", dur: 420 },
  { key: "finale", dur: 390 },
] as const;

export const D_TOTAL = SCENES.reduce((a, s) => a + s.dur, 0);
