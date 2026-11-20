import { interpolate, spring } from "remotion";

export const FPS = 60;
export const WIDTH = 1920;
export const HEIGHT = 1080;
export const TOTAL_FRAMES = 2700;

export const COLORS = {
  bgDeep: "#050811",
  bgBase: "#080D1A",
  bgPanel: "rgba(13, 21, 38, 0.86)",
  bgPanelSolid: "#0D1526",
  bgCard: "rgba(17, 27, 48, 0.88)",
  borderSubtle: "rgba(148, 163, 184, 0.16)",
  borderAccent: "rgba(56, 189, 248, 0.42)",
  textPrimary: "#F8FAFC",
  textSecondary: "#94A3B8",
  textMuted: "#64748B",
  cyan: "#38BDF8",
  cyanBright: "#00E5FF",
  indigo: "#818CF8",
  violet: "#A78BFA",
  emerald: "#10B981",
  emeraldBright: "#34D399",
  amber: "#F59E0B",
  rose: "#F43F5E",
  claude: "#F97316",
  codex: "#38BDF8",
  dsh: "#A78BFA",
  magpie: "#EC4899",
  agentUs: "#10B981",
};

export const FONT_SANS =
  '"Inter", "Microsoft YaHei", "PingFang SC", "Segoe UI", system-ui, sans-serif';
export const FONT_MONO =
  '"JetBrains Mono", "Cascadia Code", "Consolas", monospace';

export const SCENE_RANGES = [
  { id: 1, label: "01 架构融合痛点", en: "FUSION GENESIS", start: 0, duration: 420 },
  { id: 2, label: "02 五层核心蓝图", en: "5-LAYER ARCHITECTURE", start: 420, duration: 510 },
  { id: 3, label: "03 DAG 并发与七重安全门", en: "LIVE EXECUTION & GOVERNANCE", start: 930, duration: 570 },
  { id: 4, label: "04 四维架构对比矩阵", en: "ARCHITECTURE MATRIX", start: 1500, duration: 540 },
  { id: 5, label: "05 工程实测量化飞跃", en: "VERIFIED BENCHMARKS", start: 2040, duration: 390 },
  { id: 6, label: "06 Codex 1:1 桌面端交付", en: "PRODUCTION DELIVERY", start: 2430, duration: 270 },
] as const;

export const springSnappy = (frame: number, delay = 0, fps = FPS) =>
  spring({
    frame: Math.max(0, frame - delay),
    fps,
    config: { damping: 18, stiffness: 160, mass: 0.75 },
  });

export const springSmooth = (frame: number, delay = 0, fps = FPS) =>
  spring({
    frame: Math.max(0, frame - delay),
    fps,
    config: { damping: 24, stiffness: 110, mass: 0.9 },
  });

export const fadeInUp = (frame: number, delay = 0, distance = 28) => {
  const progress = springSnappy(frame, delay);
  return {
    opacity: interpolate(progress, [0, 1], [0, 1], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    }),
    transform: `translateY(${interpolate(progress, [0, 1], [distance, 0], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    })}px)`,
  };
};

export const countUp = (
  frame: number,
  startFrame: number,
  endFrame: number,
  target: number
) =>
  interpolate(frame, [startFrame, endFrame], [0, target], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

export const sceneEnvelopeOpacity = (
  localFrame: number,
  duration: number,
  fadeInFrames = 14,
  fadeOutFrames = 16
) => {
  const fadeIn = interpolate(localFrame, [0, fadeInFrames], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const fadeOut = interpolate(
    localFrame,
    [duration - fadeOutFrames, duration],
    [1, 0],
    {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    }
  );
  return Math.min(fadeIn, fadeOut);
};
