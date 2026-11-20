import React from "react";
import { AbsoluteFill, Img, interpolate, staticFile, useCurrentFrame } from "remotion";
import { EASE_IO, EASE_OUT, FONT, PAL, p, rise } from "./theme";

export const asset = (rel: string) => staticFile(`assets/${rel}`);

/* ---------------------- Living Crystalline Backdrop ----------------------- */
export const StudioBackdrop: React.FC<{ intensity?: number }> = ({ intensity = 0.74 }) => {
  const f = useCurrentFrame();
  const scale = 1.05 + Math.sin(f / 220) * 0.035;
  const dx = Math.sin(f / 280) * 28;
  const dy = Math.cos(f / 250) * 18;
  return (
    <AbsoluteFill style={{ background: PAL.bg, overflow: "hidden" }}>
      <Img
        src={asset("visuals/hero-bg.jpg")}
        style={{
          position: "absolute",
          inset: -50,
          width: "calc(100% + 100px)",
          height: "calc(100% + 100px)",
          objectFit: "cover",
          opacity: intensity,
          transform: `translate3d(${dx}px, ${dy}px, 0) scale(${scale})`,
        }}
      />
      {/* Subtle floating luminous orbs for living depth */}
      <div
        style={{
          position: "absolute",
          width: 760,
          height: 760,
          left: 160 + Math.sin(f / 140) * 90,
          top: -240 + Math.cos(f / 160) * 60,
          borderRadius: 9999,
          background: "radial-gradient(circle, rgba(59,130,246,0.14) 0%, rgba(59,130,246,0) 68%)",
          pointerEvents: "none",
        }}
      />
      <div
        style={{
          position: "absolute",
          width: 820,
          height: 820,
          right: 80 + Math.cos(f / 150) * 100,
          bottom: -300 + Math.sin(f / 130) * 70,
          borderRadius: 9999,
          background: "radial-gradient(circle, rgba(14,165,233,0.12) 0%, rgba(14,165,233,0) 68%)",
          pointerEvents: "none",
        }}
      />
      <AbsoluteFill
        style={{
          background:
            "radial-gradient(ellipse 76% 68% at 50% 48%, rgba(255,255,255,0.84) 0%, rgba(245,249,255,0.46) 64%, rgba(232,242,255,0.20) 100%)",
        }}
      />
    </AbsoluteFill>
  );
};

/* ----------------------- Specular Glass Light Sweep ----------------------- */
export const GlassSheen: React.FC<{ start: number; dur?: number }> = ({ start, dur = 48 }) => {
  const f = useCurrentFrame();
  const t = p(f, start, dur, EASE_OUT);
  if (t <= 0.01 || t >= 0.99) return null;
  return (
    <div
      style={{
        position: "absolute",
        top: -40,
        bottom: -40,
        width: "48%",
        left: `${-55 + t * 210}%`,
        transform: "skewX(-22deg)",
        background:
          "linear-gradient(90deg, rgba(255,255,255,0) 0%, rgba(255,255,255,0.65) 50%, rgba(255,255,255,0) 100%)",
        pointerEvents: "none",
        zIndex: 30,
      }}
    />
  );
};

/* ------------------------- Scene Transition Frame ------------------------- */
export const SceneFrame: React.FC<{ dur: number; children: React.ReactNode; noOut?: boolean; noIn?: boolean }> = ({
  dur,
  children,
  noOut,
  noIn,
}) => {
  const f = useCurrentFrame();
  const i = noIn ? 1 : p(f, 0, 24);
  const o = noOut ? 0 : p(f, dur - 22, 22);
  const opacity = i * (1 - o);
  const sc = interpolate(i, [0, 1], [1.028, 1]) * interpolate(o, [0, 1], [1, 0.978]);
  const ty = (1 - i) * 14 - o * 10;
  return (
    <AbsoluteFill
      style={{
        opacity,
        transform: `translate3d(0, ${ty}px, 0) scale(${sc})`,
        filter: `blur(${(1 - i) * 7 + o * 7}px)`,
        fontFamily: FONT,
        color: PAL.text,
      }}
    >
      {children}
    </AbsoluteFill>
  );
};

/* ------------------------------- Typography ------------------------------- */
export const BlueText: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <span
    style={{
      background: `linear-gradient(105deg, ${PAL.blueMid} 0%, ${PAL.blueDeep} 100%)`,
      WebkitBackgroundClip: "text",
      backgroundClip: "text",
      color: "transparent",
    }}
  >
    {children}
  </span>
);

export const TitleBlock: React.FC<{
  kicker: string;
  title: React.ReactNode;
  sub?: string;
  at?: number;
  align?: "left" | "center";
  x?: number;
  y?: number;
  width?: number;
  size?: number;
}> = ({ kicker, title, sub, at = 5, align = "center", x = 100, y = 52, width = 1100, size = 54 }) => {
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
        zIndex: 20,
      }}
    >
      <div
        style={{
          ...rise(f, at, 22, 12),
          display: "inline-flex",
          alignItems: "center",
          gap: 10,
          padding: "6px 18px",
          borderRadius: 999,
          background: "rgba(255,255,255,0.92)",
          border: `1px solid ${PAL.iceDeep}`,
          boxShadow: "0 6px 20px -10px rgba(37,99,235,0.35)",
          color: PAL.blue,
          fontSize: 17,
          fontWeight: 750,
          letterSpacing: 1.8,
        }}
      >
        <span style={{ width: 8, height: 8, borderRadius: 99, background: PAL.blue }} />
        {kicker}
      </div>
      <div
        style={{
          ...rise(f, at + 6, 26, 20),
          marginTop: 14,
          fontSize: size,
          fontWeight: 820,
          color: PAL.ink,
          letterSpacing: -0.9,
          lineHeight: 1.14,
        }}
      >
        {title}
      </div>
      {sub && (
        <div
          style={{
            ...rise(f, at + 12, 26, 16),
            marginTop: 11,
            fontSize: 22,
            color: PAL.sub,
            lineHeight: 1.48,
            maxWidth: align === "center" ? 1240 : width,
          }}
        >
          {sub}
        </div>
      )}
    </div>
  );
};

/* ------------------------------ 3D Emblem --------------------------------- */
export const BrandEmblem: React.FC<{ size?: number; style?: React.CSSProperties; float?: boolean }> = ({
  size = 120,
  style,
  float = false,
}) => {
  const f = useCurrentFrame();
  const dy = float ? Math.sin(f / 26) * 6 : 0;
  const rot = float ? Math.sin(f / 45) * 2.2 : 0;
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.28,
        overflow: "hidden",
        background: "#fff",
        boxShadow: `0 ${size * 0.16}px ${size * 0.42}px -${size * 0.14}px rgba(22,66,190,0.42), 0 0 0 1px rgba(37,99,235,0.12)`,
        display: "grid",
        placeItems: "center",
        transform: `translate3d(0, ${dy}px, 0) rotate(${rot}deg)`,
        flex: "none",
        ...style,
      }}
    >
      <Img src={asset("visuals/brand-emblem.jpg")} style={{ width: "118%", height: "118%", objectFit: "cover" }} />
    </div>
  );
};

export const Glass3DImage: React.FC<{
  src: string;
  size?: number;
  height?: number;
  floatPhase?: number;
  style?: React.CSSProperties;
}> = ({ src, size = 180, height, floatPhase = 0, style }) => {
  const f = useCurrentFrame();
  const dy = Math.sin(f / 28 + floatPhase) * 6;
  return (
    <div
      style={{
        width: size,
        height: height ?? size,
        display: "grid",
        placeItems: "center",
        transform: `translate3d(0, ${dy}px, 0)`,
        flex: "none",
        ...style,
      }}
    >
      <Img
        src={asset(src)}
        style={{ width: "100%", height: "100%", objectFit: "contain", mixBlendMode: "multiply" }}
      />
    </div>
  );
};

export const BrandLogo: React.FC<{
  file: string;
  size?: number;
  pad?: number;
  radius?: number;
  bg?: string;
  shadow?: boolean;
}> = ({ file, size = 56, pad = 10, radius = 16, bg = "#FFFFFF", shadow = true }) => (
  <div
    style={{
      width: size,
      height: size,
      borderRadius: radius,
      background: bg,
      border: `1px solid ${PAL.line}`,
      boxShadow: shadow ? "0 10px 24px -12px rgba(9,23,48,0.20)" : undefined,
      display: "grid",
      placeItems: "center",
      padding: pad,
      flex: "none",
      overflow: "hidden",
    }}
  >
    <Img src={asset(file)} style={{ width: "100%", height: "100%", objectFit: "contain" }} />
  </div>
);

/* ----------------------- Authentic Subagent Avatars ----------------------- */
export const WorkerAvatar: React.FC<{ variant: 0 | 1 | 2 | 3 | 4; size?: number }> = ({ variant, size = 18 }) => {
  if (variant === 0) {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" fill="none" style={{ flex: "none" }}>
        <circle cx="8" cy="4.2" r="2.1" fill="#8B5CF6" />
        <circle cx="11.3" cy="6.1" r="2.1" fill="#7C3AED" />
        <circle cx="11.3" cy="9.9" r="2.1" fill="#8B5CF6" />
        <circle cx="8" cy="11.8" r="2.1" fill="#7C3AED" />
        <circle cx="4.7" cy="9.9" r="2.1" fill="#8B5CF6" />
        <circle cx="4.7" cy="6.1" r="2.1" fill="#7C3AED" />
        <circle cx="8" cy="8" r="1.9" fill="#2E1065" />
      </svg>
    );
  }
  if (variant === 1) {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" fill="none" style={{ flex: "none" }}>
        <circle cx="8" cy="8" r="5.8" fill="#3B82F6" />
        <circle cx="6.2" cy="6.0" r="2.3" fill="#93C5FD" />
        <circle cx="9.8" cy="9.8" r="1.5" fill="#1D4ED8" />
      </svg>
    );
  }
  if (variant === 2) {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" fill="none" style={{ flex: "none" }}>
        <path d="M3.5 3h9L8 8l4.5 5h-9L8 8 3.5 3Z" fill="#06B6D4" />
        <path d="M5.2 3h5.6L8 6.2 5.2 3Z" fill="#0E7490" />
      </svg>
    );
  }
  if (variant === 3) {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" fill="none" style={{ flex: "none" }}>
        <circle cx="8" cy="4.4" r="2.3" fill="#34D399" />
        <circle cx="11.6" cy="8" r="2.3" fill="#10B981" />
        <circle cx="8" cy="11.6" r="2.3" fill="#34D399" />
        <circle cx="4.4" cy="8" r="2.3" fill="#10B981" />
        <circle cx="8" cy="8" r="1.7" fill="#064E3B" />
      </svg>
    );
  }
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" style={{ flex: "none" }}>
      <path d="M8 2.2C9.8 2.2 11.2 4.3 9.2 6.8L8 8V2.2Z" fill="#F97316" />
      <path d="M13.8 8C13.8 9.8 11.7 11.2 9.2 9.2L8 8H13.8Z" fill="#FB923C" />
      <path d="M8 13.8C6.2 13.8 4.8 11.7 6.8 9.2L8 8V13.8Z" fill="#F97316" />
      <path d="M2.2 8C2.2 6.2 4.3 4.8 6.8 6.8L8 8H2.2Z" fill="#FB923C" />
      <circle cx="8" cy="8" r="1.5" fill="#431407" />
    </svg>
  );
};

/* ------------------------------ Keynote Cursor ---------------------------- */
export type CursorKey = { f: number; x: number; y: number; click?: boolean };

export const Cursor: React.FC<{ keys: CursorKey[]; show?: [number, number] }> = ({ keys, show }) => {
  const f = useCurrentFrame();
  const frames = keys.map((k) => k.f);
  const x = interpolate(f, frames, keys.map((k) => k.x), {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: EASE_IO,
  });
  const y = interpolate(f, frames, keys.map((k) => k.y), {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: EASE_IO,
  });
  let press = 0;
  let ring = -1;
  for (const k of keys) {
    if (!k.click) continue;
    const d = f - k.f;
    if (d >= 0 && d < 14) press = Math.max(press, Math.sin((d / 14) * Math.PI));
    if (d >= 0 && d < 30) ring = d / 30;
  }
  const vis = show ? p(f, show[0], 10) * (1 - p(f, show[1], 10)) : 1;
  return (
    <div style={{ position: "absolute", left: x, top: y, zIndex: 120, opacity: vis, pointerEvents: "none" }}>
      {ring >= 0 && (
        <div
          style={{
            position: "absolute",
            left: -28 * (0.35 + ring),
            top: -28 * (0.35 + ring),
            width: 56 * (0.35 + ring),
            height: 56 * (0.35 + ring),
            borderRadius: 999,
            border: `2.5px solid ${PAL.blue}`,
            opacity: 1 - ring,
          }}
        />
      )}
      <svg
        width={28}
        height={28}
        viewBox="0 0 24 24"
        style={{
          transform: `scale(${1 - press * 0.2})`,
          transformOrigin: "0 0",
          filter: "drop-shadow(0 4px 8px rgba(9,23,48,0.34))",
        }}
      >
        <path
          d="M3 2l7.5 19 2.6-7.6L21 10.8z"
          fill={PAL.ink}
          stroke="#fff"
          strokeWidth={1.7}
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
};

/* ----------------------------- Floating Callout --------------------------- */
export const CalloutBanner: React.FC<{
  at: number;
  until: number;
  x?: number;
  y: number;
  center?: boolean;
  badge: string;
  title: string;
  sub: string;
  tone?: "blue" | "green" | "amber";
}> = ({ at, until, x = 0, y, center = false, badge, title, sub, tone = "blue" }) => {
  const f = useCurrentFrame();
  const s = p(f, at, 22);
  const o = p(f, until, 18);
  const op = s * (1 - o);
  if (op <= 0.01) return null;
  const col = tone === "green" ? PAL.green : tone === "amber" ? PAL.amber : PAL.blue;
  const soft = tone === "green" ? PAL.greenBg : tone === "amber" ? PAL.amberBg : PAL.ice;
  return (
    <div
      style={{
        position: "absolute",
        left: center ? "50%" : x,
        top: y,
        opacity: op,
        transform: center
          ? `translate3d(-50%, ${(1 - s) * 12}px, 0) scale(${0.95 + s * 0.05})`
          : `translate3d(0, ${(1 - s) * 14}px, 0) scale(${0.94 + s * 0.06})`,
        display: "flex",
        alignItems: "center",
        gap: 14,
        padding: "11px 22px 11px 14px",
        borderRadius: 16,
        background: "rgba(255,255,255,0.96)",
        border: `1.5px solid ${col}38`,
        boxShadow: `0 18px 42px -16px ${col}48`,
        zIndex: 80,
        whiteSpace: "nowrap",
        overflow: "hidden",
      }}
    >
      <GlassSheen start={at + 4} dur={42} />
      <div
        style={{
          padding: "6px 12px",
          borderRadius: 10,
          background: soft,
          color: col,
          fontSize: 14.5,
          fontWeight: 800,
          letterSpacing: 0.5,
          whiteSpace: "nowrap",
        }}
      >
        {badge}
      </div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 14 }}>
        <div style={{ fontSize: 20, fontWeight: 800, color: PAL.ink, lineHeight: 1.2 }}>{title}</div>
        <div style={{ fontSize: 15, color: PAL.sub }}>{sub}</div>
      </div>
    </div>
  );
};

/* ------------------------- Crisp UI Chrome Icons -------------------------- */
const RailIcon: React.FC<{ kind: number; active: boolean }> = ({ kind, active }) => {
  const c = active ? "#FFFFFF" : "#64748B";
  const sw = 1.75;
  return (
    <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round">
      {kind === 0 && (
        <>
          <path d="M3 10.5L12 3l9 7.5" />
          <path d="M5.5 9.5V20h13V9.5" />
          <path d="M9.5 20v-6h5v6" />
        </>
      )}
      {kind === 1 && (
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="M3 12h18M12 3a14 14 0 010 18M12 3a14 14 0 000 18" />
        </>
      )}
      {kind === 2 && (
        <>
          <rect x="6" y="6" width="12" height="12" rx="2.5" />
          <path d="M9 1.5v4.5M15 1.5v4.5M9 18v4.5M15 18v4.5M1.5 9h4.5M1.5 15h4.5M18 9h4.5M18 15h4.5" />
        </>
      )}
      {kind === 3 && <path d="M5 13l4.5 4.5L19 7" />}
      {kind === 4 && (
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3.2 2" />
        </>
      )}
      {kind === 5 && (
        <>
          <circle cx="12" cy="12" r="8.5" />
          <path d="M12 7.5v9M7.5 12h9" />
        </>
      )}
      {kind === 6 && (
        <>
          <circle cx="6" cy="12" r="1.3" fill={c} stroke="none" />
          <circle cx="12" cy="12" r="1.3" fill={c} stroke="none" />
          <circle cx="18" cy="12" r="1.3" fill={c} stroke="none" />
        </>
      )}
      {kind === 7 && (
        <>
          <circle cx="12" cy="12" r="3" />
          <path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M5.2 5.2l1.8 1.8M17 17l1.8 1.8M5.2 18.8L7 17M17 7l1.8-1.8" />
        </>
      )}
    </svg>
  );
};

/* ----------------------------- Desktop Shell ------------------------------ */
export const SHELL_W = 1520;
export const SHELL_H = 880;

export const DesktopShell: React.FC<{
  activeRail?: number;
  showSidebar?: boolean;
  sidebarContent?: React.ReactNode;
  children: React.ReactNode;
  statusText?: string;
  style?: React.CSSProperties;
}> = ({
  activeRail = 0,
  showSidebar = true,
  sidebarContent,
  children,
  statusText = "已连接 Backend",
  style,
}) => (
  <div
    style={{
      width: SHELL_W,
      height: SHELL_H,
      borderRadius: 18,
      background: "#FFFFFF",
      overflow: "hidden",
      boxShadow:
        "0 50px 120px -28px rgba(15,40,95,0.28), 0 18px 38px -18px rgba(9,23,48,0.16), 0 0 0 1px rgba(15,23,42,0.08)",
      display: "flex",
      flexDirection: "column",
      fontFamily: FONT,
      ...style,
    }}
  >
    <div
      style={{
        height: 38,
        flex: "none",
        background: "#F7F9FC",
        borderBottom: "1px solid rgba(15,23,42,0.06)",
        display: "flex",
        alignItems: "center",
        padding: "0 14px",
        gap: 16,
        fontSize: 12.5,
        color: "#64748B",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 11, color: "#94A3B8" }}>
        <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
          <path d="M19 12H5M11 6l-6 6 6 6" />
        </svg>
        <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
          <path d="M5 12h14M13 6l6 6-6 6" />
        </svg>
        <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="#475569" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="4" width="18" height="16" rx="2.5" />
          <path d="M9 4v16" />
        </svg>
      </div>
      {["文件", "编辑", "视图", "帮助"].map((m) => (
        <span key={m} style={{ fontSize: 12.5, color: "#475569", fontWeight: 480 }}>
          {m}
        </span>
      ))}
      <div style={{ flex: 1 }} />
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          fontSize: 12,
          fontWeight: 560,
          color: "#475569",
        }}
      >
        <span style={{ width: 7, height: 7, borderRadius: 99, background: "#12A150" }} />
        {statusText}
      </span>
    </div>

    <div style={{ flex: 1, display: "flex", minHeight: 0, background: "#F7F9FC" }}>
      <div
        style={{
          width: 48,
          flex: "none",
          background: "#F7F9FC",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          padding: "10px 0 12px",
          gap: 8,
        }}
      >
        {[0, 1, 2, 3, 4, 5, 6].map((idx) => {
          const active = idx === activeRail;
          return (
            <div
              key={idx}
              style={{
                width: 34,
                height: 34,
                borderRadius: 10,
                background: active ? `linear-gradient(135deg, ${PAL.blueMid}, ${PAL.blueDeep})` : "transparent",
                boxShadow: active ? "0 6px 14px -6px rgba(37,99,235,0.55)" : undefined,
                display: "grid",
                placeItems: "center",
              }}
            >
              <RailIcon kind={idx} active={active} />
            </div>
          );
        })}
        <div style={{ flex: 1 }} />
        <div style={{ width: 34, height: 34, borderRadius: 10, display: "grid", placeItems: "center" }}>
          <RailIcon kind={7} active={false} />
        </div>
      </div>

      {showSidebar && (
        <div
          style={{
            width: 242,
            flex: "none",
            background: "#F7F9FC",
            padding: "10px 12px 14px 4px",
            display: "flex",
            flexDirection: "column",
            gap: 2,
            fontSize: 13.5,
            color: PAL.text,
          }}
        >
          {sidebarContent}
        </div>
      )}

      <div
        style={{
          flex: 1,
          position: "relative",
          minWidth: 0,
          overflow: "hidden",
          background: "#FFFFFF",
          borderTopLeftRadius: 14,
          borderLeft: "1px solid rgba(15,23,42,0.06)",
          borderTop: "1px solid rgba(15,23,42,0.06)",
        }}
      >
        {children}
      </div>
    </div>
  </div>
);

export const DefaultSidebar: React.FC<{
  activeThread?: string;
  running?: boolean;
  pendingApproval?: boolean;
}> = ({ activeThread, running, pendingApproval }) => {
  const f = useCurrentFrame();
  const threads = [
    {
      title: "优化 Task Engine 调度队列与多模型路由",
      active: activeThread === "main",
      running: running && activeThread === "main",
      warn: pendingApproval && activeThread === "main",
    },
    { title: "审批网关过期自动吊销与幂等验证", active: false },
    { title: "Fencing 租约强杀接管回归压测", active: false },
    { title: "T0 防幻觉门禁与有界自愈校准", active: false },
  ];
  return (
    <>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "4px 8px 12px" }}>
        <span style={{ fontSize: 15.5, fontWeight: 800, color: PAL.ink, letterSpacing: -0.3, display: "inline-flex", alignItems: "center", gap: 5 }}>
          Agent_<span style={{ color: PAL.blue }}>US</span>
          <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="#94A3B8" strokeWidth={2} strokeLinecap="round">
            <path d="M6 9l6 6 6-6" />
          </svg>
        </span>
        <div style={{ display: "flex", alignItems: "center", gap: 10, color: "#64748B" }}>
          <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round">
            <path d="M18 8a6 6 0 10-12 0c0 7-3 8-3 8h18s-3-1-3-8M13.73 21a2 2 0 01-3.46 0" />
          </svg>
          <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round">
            <circle cx="11" cy="11" r="7" />
            <path d="M20 20l-3.5-3.5" />
          </svg>
        </div>
      </div>

      <div
        style={{
          height: 32,
          borderRadius: 8,
          padding: "0 8px",
          display: "flex",
          alignItems: "center",
          gap: 9,
          fontWeight: 540,
          fontSize: 13.5,
          color: "#1E293B",
          marginBottom: 14,
        }}
      >
        <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="#475569" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
          <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
          <path d="M18.5 2.5a2.12 2.12 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
        </svg>
        <span>新聊天</span>
      </div>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "4px 8px 6px", fontSize: 12, color: "#64748B", fontWeight: 560 }}>
        <span>项目</span>
        <span style={{ fontSize: 15, color: "#94A3B8", lineHeight: 1 }}>+</span>
      </div>
      {[
        { name: "Agent_US", active: true },
        { name: "order-engine", active: false },
        { name: "analytics-lab", active: false },
      ].map((pr) => (
        <div
          key={pr.name}
          style={{
            height: 30,
            borderRadius: 8,
            padding: "0 9px",
            display: "flex",
            alignItems: "center",
            gap: 8,
            background: pr.active ? "rgba(15,23,42,0.05)" : "transparent",
            color: pr.active ? PAL.ink : "#475569",
            fontWeight: pr.active ? 580 : 450,
            fontSize: 13,
          }}
        >
          <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke={pr.active ? PAL.blue : "#64748B"} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
          </svg>
          <span>{pr.name}</span>
        </div>
      ))}

      <div style={{ padding: "16px 8px 6px", fontSize: 12, color: "#64748B", fontWeight: 560 }}>最近</div>
      {threads.map((t) => (
        <div
          key={t.title}
          style={{
            height: 30,
            borderRadius: 8,
            padding: "0 9px",
            display: "flex",
            alignItems: "center",
            gap: 8,
            background: t.active ? "rgba(37,99,235,0.08)" : "transparent",
            color: t.active ? PAL.blueDeep : "#475569",
            fontWeight: t.active ? 600 : 440,
            fontSize: 12.8,
            overflow: "hidden",
          }}
        >
          {t.warn ? (
            <span style={{ width: 7, height: 7, borderRadius: 99, background: PAL.amber, flex: "none" }} />
          ) : t.running ? (
            <span
              style={{
                width: 11,
                height: 11,
                borderRadius: 99,
                border: `1.8px solid ${PAL.iceDeep}`,
                borderTopColor: PAL.blue,
                transform: `rotate(${f * 12}deg)`,
                flex: "none",
              }}
            />
          ) : (
            <span style={{ width: 5, height: 5, borderRadius: 99, background: t.active ? PAL.green : "#CBD5E1", flex: "none", margin: "0 1px" }} />
          )}
          <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{t.title}</span>
        </div>
      ))}
    </>
  );
};
