import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { C, FONT, prog, rise } from "./theme";

/* ---------------------------------- Icons --------------------------------- */
const P: Record<string, React.ReactNode> = {
  chat: <path d="M4 5h16v11H9l-5 4z" />,
  pool: (
    <>
      <circle cx="8" cy="9" r="3" />
      <circle cx="16" cy="9" r="3" />
      <path d="M2.5 19c.8-3 3-4.5 5.5-4.5s4.7 1.5 5.5 4.5M10.5 19c.8-3 3-4.5 5.5-4.5s4.7 1.5 5.5 4.5" />
    </>
  ),
  cube: <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9zM12 12l8-4.5M12 12v9M12 12L4 7.5" />,
  calendar: (
    <>
      <rect x="3.5" y="5" width="17" height="15" rx="2.5" />
      <path d="M3.5 10h17M8 3v4M16 3v4M9 15l2 2 4-4" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  puzzle: <path d="M9 4h3v2a1.5 1.5 0 003 0V4h4v5h-2a1.5 1.5 0 000 3h2v8h-5v-2a1.5 1.5 0 00-3 0v2H4v-5h2a1.5 1.5 0 000-3H4V4z" />,
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16l4 4" />
    </>
  ),
  folder: <path d="M3.5 6.5a2 2 0 012-2h4l2 2h7a2 2 0 012 2v9a2 2 0 01-2 2h-13a2 2 0 01-2-2z" />,
  terminal: (
    <>
      <rect x="3" y="4.5" width="18" height="15" rx="2.5" />
      <path d="M7 9.5l3 2.5-3 2.5M12.5 15h4.5" />
    </>
  ),
  file: <path d="M6 3h8l4 4v14H6zM14 3v4h4" />,
  edit: <path d="M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4" />,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  spark: <path d="M12 3l1.9 5.6L19.5 10l-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.4z" />,
  branch: (
    <>
      <circle cx="6" cy="5.5" r="2" />
      <circle cx="6" cy="18.5" r="2" />
      <circle cx="18" cy="8" r="2" />
      <path d="M6 7.5v9M18 10c0 4-6 3-12 6.5" />
    </>
  ),
  shield: <path d="M12 3l7.5 3v6c0 4.5-3.2 7.8-7.5 9-4.3-1.2-7.5-4.5-7.5-9V6zM8.5 12l2.5 2.5 4.5-4.5" />,
  zap: <path d="M13 2.5L4.5 13.5H11l-1 8 8.5-11H12z" />,
  layers: <path d="M12 3l9 5-9 5-9-5zM3 12.5l9 5 9-5M3 16.5l9 5 9-5" />,
  bot: (
    <>
      <rect x="4.5" y="7.5" width="15" height="11" rx="3" />
      <path d="M12 4v3.5M9 12.5h.01M15 12.5h.01M2.5 12v3M21.5 12v3" />
    </>
  ),
  arrowUp: <path d="M12 19V5M6 11l6-6 6 6" />,
  rewind: <path d="M11 6L4 12l7 6zM20 6l-7 6 7 6z" />,
  compress: <path d="M4 9h5V4M20 9h-5V4M4 15h5v5M20 15h-5v5" />,
  steer: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="2" />
      <path d="M12 3.5V10M5 16l5.3-3M19 16l-5.3-3" />
    </>
  ),
  plug: <path d="M9 3v5M15 3v5M6.5 8h11v3a5.5 5.5 0 01-11 0zM12 16.5V21" />,
  brain: <path d="M9 4.5a3 3 0 00-3 3 3 3 0 00-2 5 3 3 0 002 5 3 3 0 006 .5V5.5a2.5 2.5 0 00-3-1zM15 4.5a3 3 0 013 3 3 3 0 012 5 3 3 0 01-2 5 3 3 0 01-6 .5" />,
  chart: <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />,
  desktop: (
    <>
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M8 20h8M12 16v4" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="10.5" width="14" height="10" rx="2.5" />
      <path d="M8 10.5V7.5a4 4 0 018 0v3" />
    </>
  ),
  db: (
    <>
      <ellipse cx="12" cy="6" rx="7.5" ry="2.8" />
      <path d="M4.5 6v12c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8V6M4.5 12c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8" />
    </>
  ),
  stop: <rect x="7" y="7" width="10" height="10" rx="2" />,
  chevron: <path d="M7 10l5 5 5-5" />,
};

export const Icon: React.FC<{
  name: keyof typeof P | string;
  size?: number;
  color?: string;
  stroke?: number;
  style?: React.CSSProperties;
}> = ({ name, size = 18, color = "currentColor", stroke = 1.8, style }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke={color}
    strokeWidth={stroke}
    strokeLinecap="round"
    strokeLinejoin="round"
    style={{ flex: "none", ...style }}
  >
    {P[name]}
  </svg>
);

/* ---------------------------------- Logo ---------------------------------- */
export const Logo: React.FC<{ size?: number; spin?: number }> = ({ size = 64, spin = 0 }) => {
  const r = size / 2;
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.28,
        background: `linear-gradient(140deg, ${C.blueMid} 0%, ${C.blueDeep} 100%)`,
        boxShadow: `0 ${size * 0.18}px ${size * 0.5}px -${size * 0.15}px rgba(37,99,235,0.55), inset 0 1px 0 rgba(255,255,255,0.35)`,
        position: "relative",
        flex: "none",
      }}
    >
      <svg width={size} height={size} viewBox="0 0 64 64" style={{ position: "absolute", inset: 0 }}>
        <path
          d="M20 44 L32 18 L44 44"
          fill="none"
          stroke="#fff"
          strokeWidth={5.2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path d="M25.5 35 H38.5" stroke="#fff" strokeWidth={4.6} strokeLinecap="round" />
        <g transform={`rotate(${spin} 32 32)`}>
          <ellipse cx="32" cy="32" rx="25" ry="9.5" fill="none" stroke="rgba(255,255,255,0.45)" strokeWidth={1.6} transform="rotate(-24 32 32)" />
          <circle cx={32 + 25 * Math.cos(-0.42)} cy={32 + 25 * Math.sin(-0.42) * 0.38 - 4} r={3.2} fill="#BFE0FF" />
        </g>
      </svg>
      <div style={{ position: "absolute", inset: 0, borderRadius: r * 0.56 }} />
    </div>
  );
};

/* ------------------------------- Background ------------------------------- */
export const Background: React.FC = () => {
  const f = useCurrentFrame();
  const t = f / 60;
  return (
    <AbsoluteFill style={{ background: C.bg, overflow: "hidden" }}>
      <div
        style={{
          position: "absolute",
          width: 1300,
          height: 1300,
          left: -380 + Math.sin(t * 0.35) * 90,
          top: -620 + Math.cos(t * 0.3) * 70,
          background: "radial-gradient(circle, rgba(96,165,250,0.30) 0%, rgba(96,165,250,0) 62%)",
        }}
      />
      <div
        style={{
          position: "absolute",
          width: 1400,
          height: 1400,
          right: -520 + Math.cos(t * 0.28) * 100,
          bottom: -760 + Math.sin(t * 0.32) * 80,
          background: "radial-gradient(circle, rgba(37,99,235,0.20) 0%, rgba(37,99,235,0) 60%)",
        }}
      />
      <AbsoluteFill
        style={{
          backgroundImage: "radial-gradient(rgba(37,99,235,0.13) 1.2px, transparent 1.2px)",
          backgroundSize: "34px 34px",
          backgroundPosition: `${(t * 6) % 34}px ${(t * 4) % 34}px`,
          maskImage: "radial-gradient(ellipse at center, rgba(0,0,0,0.85) 0%, rgba(0,0,0,0) 75%)",
          WebkitMaskImage: "radial-gradient(ellipse at center, rgba(0,0,0,0.85) 0%, rgba(0,0,0,0) 75%)",
        }}
      />
    </AbsoluteFill>
  );
};

/* ------------------------------- SceneWrap -------------------------------- */
export const SceneWrap: React.FC<{ dur: number; children: React.ReactNode; noOut?: boolean }> = ({
  dur,
  children,
  noOut,
}) => {
  const f = useCurrentFrame();
  const i = prog(f, 0, 22);
  const o = noOut ? 0 : prog(f, dur - 20, 20);
  const opacity = i * (1 - o);
  const scale = interpolate(i, [0, 1], [1.025, 1]) * interpolate(o, [0, 1], [1, 0.975]);
  return (
    <AbsoluteFill
      style={{
        opacity,
        transform: `scale(${scale})`,
        filter: `blur(${(1 - i) * 8 + o * 8}px)`,
        fontFamily: FONT,
        color: C.text,
      }}
    >
      {children}
    </AbsoluteFill>
  );
};

/* ------------------------------- SceneTitle ------------------------------- */
export const SceneTitle: React.FC<{
  kicker: string;
  title: React.ReactNode;
  desc?: string;
  at?: number;
  x?: number;
  y?: number;
  align?: "left" | "center";
  width?: number;
}> = ({ kicker, title, desc, at = 6, x = 120, y = 96, align = "left", width = 900 }) => {
  const f = useCurrentFrame();
  return (
    <div
      style={{
        position: "absolute",
        left: align === "center" ? 0 : x,
        right: align === "center" ? 0 : undefined,
        top: y,
        width: align === "center" ? undefined : width,
        textAlign: align,
        display: "flex",
        flexDirection: "column",
        alignItems: align === "center" ? "center" : "flex-start",
      }}
    >
      <div
        style={{
          ...rise(f, at, 24, 14),
          display: "inline-flex",
          alignItems: "center",
          gap: 10,
          padding: "7px 16px",
          borderRadius: 999,
          background: C.ice,
          color: C.blue,
          fontSize: 19,
          fontWeight: 650,
          letterSpacing: 2,
        }}
      >
        <span style={{ width: 7, height: 7, borderRadius: 9, background: C.blue }} />
        {kicker}
      </div>
      <div
        style={{
          ...rise(f, at + 6, 28, 22),
          marginTop: 20,
          fontSize: 60,
          fontWeight: 760,
          color: C.ink,
          letterSpacing: -0.5,
          lineHeight: 1.15,
        }}
      >
        {title}
      </div>
      {desc && (
        <div style={{ ...rise(f, at + 14, 28, 18), marginTop: 16, fontSize: 25, color: C.sub, lineHeight: 1.55, whiteSpace: "pre-line" }}>
          {desc}
        </div>
      )}
    </div>
  );
};

export const Blue: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <span
    style={{
      background: `linear-gradient(100deg, ${C.blueMid}, ${C.blueDeep})`,
      WebkitBackgroundClip: "text",
      backgroundClip: "text",
      color: "transparent",
    }}
  >
    {children}
  </span>
);

/* --------------------------------- Cursor --------------------------------- */
export type CursorKey = { f: number; x: number; y: number; click?: boolean };

export const Cursor: React.FC<{ keys: CursorKey[]; show?: [number, number] }> = ({ keys, show }) => {
  const f = useCurrentFrame();
  const frames = keys.map((k) => k.f);
  const x = interpolate(f, frames, keys.map((k) => k.x), {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  });
  const y = interpolate(f, frames, keys.map((k) => k.y), {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  });
  let press = 0;
  let ring = -1;
  for (const k of keys) {
    if (!k.click) continue;
    const d = f - k.f;
    if (d >= 0 && d < 14) press = Math.max(press, Math.sin((d / 14) * Math.PI));
    if (d >= 0 && d < 30) ring = d / 30;
  }
  const vis = show ? prog(f, show[0], 12) * (1 - prog(f, show[1], 12)) : 1;
  return (
    <div style={{ position: "absolute", left: x, top: y, zIndex: 100, opacity: vis, pointerEvents: "none" }}>
      {ring >= 0 && (
        <div
          style={{
            position: "absolute",
            left: -26 * (0.4 + ring),
            top: -26 * (0.4 + ring),
            width: 52 * (0.4 + ring),
            height: 52 * (0.4 + ring),
            borderRadius: 999,
            border: `3px solid ${C.blue}`,
            opacity: 1 - ring,
          }}
        />
      )}
      <svg
        width={30}
        height={30}
        viewBox="0 0 24 24"
        style={{ transform: `scale(${1 - press * 0.18})`, transformOrigin: "0 0", filter: "drop-shadow(0 3px 6px rgba(11,27,58,0.3))" }}
      >
        <path d="M3 2l7.5 19 2.6-7.6L21 10.8z" fill={C.ink} stroke="#fff" strokeWidth={1.6} strokeLinejoin="round" />
      </svg>
    </div>
  );
};

/* --------------------------------- Callout -------------------------------- */
export const Callout: React.FC<{
  at: number;
  x: number;
  y: number;
  icon?: string;
  title: string;
  sub?: string;
  until?: number;
}> = ({ at, x, y, icon = "spark", title, sub, until }) => {
  const f = useCurrentFrame();
  const s = prog(f, at, 26);
  const o = until ? prog(f, until, 16) : 0;
  return (
    <div
      style={{
        position: "absolute",
        left: x,
        top: y,
        opacity: s * (1 - o),
        transform: `translateY(${(1 - s) * 16}px) scale(${0.92 + s * 0.08})`,
        display: "flex",
        alignItems: "center",
        gap: 14,
        padding: "14px 22px 14px 14px",
        borderRadius: 18,
        background: "rgba(255,255,255,0.92)",
        border: `1px solid ${C.iceDeep}`,
        boxShadow: "0 18px 40px -14px rgba(23,71,201,0.35)",
        zIndex: 50,
        fontFamily: FONT,
      }}
    >
      <div
        style={{
          width: 42,
          height: 42,
          borderRadius: 12,
          background: `linear-gradient(140deg, ${C.blueMid}, ${C.blueDeep})`,
          display: "grid",
          placeItems: "center",
        }}
      >
        <Icon name={icon} size={22} color="#fff" stroke={2} />
      </div>
      <div>
        <div style={{ fontSize: 22, fontWeight: 700, color: C.ink }}>{title}</div>
        {sub && <div style={{ fontSize: 16, color: C.sub, marginTop: 3 }}>{sub}</div>}
      </div>
    </div>
  );
};

export const Chip: React.FC<{ children: React.ReactNode; style?: React.CSSProperties; active?: boolean }> = ({
  children,
  style,
  active,
}) => (
  <span
    style={{
      display: "inline-flex",
      alignItems: "center",
      gap: 6,
      padding: "4px 10px",
      borderRadius: 999,
      fontSize: 12.5,
      fontWeight: 520,
      background: active ? C.ice : "rgba(13,27,58,0.045)",
      color: active ? C.blue : C.sub,
      border: `1px solid ${active ? C.iceDeep : "transparent"}`,
      ...style,
    }}
  >
    {children}
  </span>
);

export const Shimmer: React.FC<{ text: string; f: number; style?: React.CSSProperties }> = ({ text, f, style }) => (
  <span
    style={{
      background: `linear-gradient(90deg, ${C.muted} 0%, ${C.muted} 35%, ${C.blue} 50%, ${C.muted} 65%, ${C.muted} 100%)`,
      backgroundSize: "300% 100%",
      backgroundPosition: `${100 - ((f * 1.6) % 200)}% 0`,
      WebkitBackgroundClip: "text",
      backgroundClip: "text",
      color: "transparent",
      ...style,
    }}
  >
    {text}
  </span>
);
