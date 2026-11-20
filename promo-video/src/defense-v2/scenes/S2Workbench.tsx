import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { PAL, mix, p, rise, typed } from "../theme";
import {
  BrandEmblem,
  CalloutBanner,
  Cursor,
  DefaultSidebar,
  DesktopShell,
  SHELL_H,
  SHELL_W,
} from "../components";

export const DEMO_PROMPT = "优化 Task Engine 调度队列与多模型路由选择，补齐单测并输出性能压测报告。";

/* ---- Exact Clean Minimalist Composer matching ui-home.png & ui-thread-companion.png ---- */
export const ComposerBox: React.FC<{
  text: string;
  caret?: boolean;
  focus?: number;
  width?: number;
  running?: boolean;
  sendGlow?: number;
  showTray?: boolean;
  placeholder?: string;
}> = ({
  text,
  caret,
  focus = 0,
  width = 688,
  running = false,
  sendGlow = 0,
  showTray = true,
  placeholder = "和 Agent_US 一起工作",
}) => (
  <div style={{ width, display: "flex", flexDirection: "column", alignItems: "center" }}>
    {/* Subtle top nested bar (only on Home view, matching ui-home.png) */}
    {showTray && (
      <div
        style={{
          width: "94%",
          height: 32,
          borderRadius: "12px 12px 0 0",
          background: "#F4F6FA",
          border: "1px solid rgba(13,13,13,0.065)",
          borderBottom: "none",
          padding: "0 14px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          fontSize: 12.5,
          color: "#64748B",
        }}
      >
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="#64748B" strokeWidth={1.7}>
            <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
          </svg>
          Agent_US Workspace
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="#64748B" strokeWidth={1.8}>
            <circle cx="6" cy="6" r="2.2" />
            <circle cx="6" cy="18" r="2.2" />
            <circle cx="18" cy="8" r="2.2" />
            <path d="M6 8.2v7.6M18 10.2c0 4-6 3-12 5.8" />
          </svg>
          main
        </span>
      </div>
    )}

    {/* Clean Pure White Composer Card (exact ui-thread-companion.png styling) */}
    <div
      style={{
        width: "100%",
        borderRadius: 20,
        background: "#FFFFFF",
        border: `1px solid ${focus > 0.5 ? PAL.sky : "rgba(13,13,13,0.09)"}`,
        boxShadow: `0 0 0 ${focus * 4}px rgba(37,99,235,0.10), 0 6px 24px -10px rgba(13,27,58,0.10)`,
        padding: "14px 16px 12px 18px",
      }}
    >
      <div
        style={{
          minHeight: 38,
          fontSize: 14.5,
          lineHeight: "22px",
          color: text ? "#0D0D0D" : "#94A3B8",
          fontWeight: 430,
        }}
      >
        {text || placeholder}
        {caret && (
          <span
            style={{
              display: "inline-block",
              width: 2,
              height: 18,
              background: PAL.blue,
              marginLeft: 2,
              verticalAlign: -3,
              borderRadius: 2,
            }}
          />
        )}
      </div>

      {/* Whisper-clean bottom bar: + | 🛡 帮我批准 | ⎇ main    auto 极高 ▾  (↑) */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 10, fontSize: 13, color: "#64748B" }}>
        <span style={{ fontSize: 19, fontWeight: 350, color: "#475569", lineHeight: 1 }}>+</span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 5, whiteSpace: "nowrap" }}>
          <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="#64748B" strokeWidth={1.8}>
            <path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z" />
          </svg>
          帮我批准
        </span>
        {!showTray && (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 5, whiteSpace: "nowrap" }}>
            <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="#64748B" strokeWidth={1.8}>
              <circle cx="6" cy="6" r="2.2" />
              <circle cx="6" cy="18" r="2.2" />
              <circle cx="18" cy="8" r="2.2" />
              <path d="M6 8.2v7.6M18 10.2c0 4-6 3-12 5.8" />
            </svg>
            main
          </span>
        )}
        <div style={{ flex: 1 }} />
        <span style={{ display: "inline-flex", alignItems: "center", gap: 5, whiteSpace: "nowrap" }}>
          <strong style={{ color: "#0D0D0D", fontWeight: 620 }}>auto</strong>
          <span style={{ color: "#64748B" }}>极高</span>
          <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="#94A3B8" strokeWidth={2}>
            <path d="M6 9l6 6 6-6" />
          </svg>
        </span>
        <span
          style={{
            width: 30,
            height: 30,
            borderRadius: 99,
            display: "grid",
            placeItems: "center",
            background: text || running ? PAL.blue : "#E2E8F0",
            color: text || running ? "#FFFFFF" : "#64748B",
            fontSize: 15,
            fontWeight: 700,
            flex: "none",
            boxShadow: `0 0 0 ${sendGlow * 8}px rgba(37,99,235,${0.25 * sendGlow})`,
          }}
        >
          {running ? "■" : "↑"}
        </span>
      </div>
    </div>
  </div>
);

export const S2Workbench: React.FC = () => {
  const f = useCurrentFrame();
  const enter = p(f, 0, 66);
  const focus = p(f, 150, 14);
  const typeStart = 172;
  const text = typed(DEMO_PROMPT, f, typeStart, 0.28);
  const sent = f >= 430;
  const after = p(f, 434, 48);
  const sendGlow = f >= 422 && f <= 452 ? Math.sin(((f - 422) / 30) * Math.PI) : 0;

  const rotX = mix(enter, 18, 0);
  const rotY = mix(enter, -6, 0);
  const ty = mix(enter, 170, 0);
  const scale = mix(enter, 0.84, 1.06);

  return (
    <AbsoluteFill style={{ perspective: 2400 }}>
      <div
        style={{
          position: "absolute",
          left: (1920 - SHELL_W) / 2,
          top: 108,
          width: SHELL_W,
          height: SHELL_H,
          transform: `translateY(${ty}px) rotateX(${rotX}deg) rotateY(${rotY}deg) scale(${scale})`,
          transformOrigin: "50% 0%",
        }}
      >
        <DesktopShell
          activeRail={0}
          sidebarContent={<DefaultSidebar activeThread={sent ? "main" : undefined} running={sent} />}
        >
          <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center" }}>
            {/* Centered Airy Home Hero matching ui-home.png */}
            <div
              style={{
                marginTop: mix(after, 250, 80),
                opacity: 1 - after,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
              }}
            >
              <div style={rise(f, 38, 28)}>
                <BrandEmblem size={64} float />
              </div>
              <div
                style={{
                  ...rise(f, 50, 28),
                  fontSize: 32,
                  fontWeight: 680,
                  color: "#0D0D0D",
                  marginTop: 22,
                  letterSpacing: -0.5,
                }}
              >
                你想让我们在
                <span
                  style={{
                    margin: "0 8px",
                    paddingBottom: 2,
                    borderBottom: "1.5px dashed rgba(37,99,235,0.45)",
                    color: PAL.blueDeep,
                  }}
                >
                  Agent_US Workspace
                </span>
                中构建什么？
              </div>
            </div>

            {/* Sent User Message Bubble (matches S3 exact position!) */}
            {sent && (
              <div
                style={{
                  position: "absolute",
                  left: 118,
                  width: 688,
                  top: mix(after, 620, 96),
                  opacity: after,
                  display: "flex",
                  justifyContent: "flex-end",
                }}
              >
                <div
                  style={{
                    maxWidth: 460,
                    padding: "11px 16px",
                    borderRadius: 18,
                    background: "rgba(13,13,13,0.048)",
                    color: "#0D0D0D",
                    fontSize: 14,
                    lineHeight: "22px",
                  }}
                >
                  {DEMO_PROMPT}
                </div>
              </div>
            )}

            {/* Minimalist Composer glides smoothly to bottom dock */}
            <div
              style={{
                ...rise(f, 70, 30),
                position: "absolute",
                top: mix(after, 616, 708),
                left: mix(after, (1230 - 688) / 2, 118),
              }}
            >
              <ComposerBox
                text={sent ? "" : text}
                caret={!sent && f >= typeStart && f % 36 < 20}
                focus={focus}
                sendGlow={sendGlow}
                running={sent}
                showTray={!sent}
                width={688}
              />
            </div>
          </div>
        </DesktopShell>

        {/* Smooth Keynote Cursor */}
        <Cursor
          show={[105, 465]}
          keys={[
            { f: 105, x: 1080, y: 780 },
            { f: 150, x: 700, y: 705, click: true },
            { f: 380, x: 700, y: 705 },
            { f: 424, x: 1218, y: 752, click: true },
            { f: 465, x: 1260, y: 800 },
          ]}
        />
      </div>

      {/* Top Keynote Callouts — zero overlap */}
      <CalloutBanner
        at={80}
        until={245}
        center
        y={22}
        badge="桌面工作台"
        title="蓝白极简一体化工程界面"
        sub="对话 · 号池 · 模型 · 签到 · 定时 · 插件 六大中心一站直达"
      />
      <CalloutBanner
        at={265}
        until={430}
        center
        y={22}
        badge="异构路由"
        title="多厂商号池智能选型"
        sub="按任务复杂度与角色权重，自动匹配最擅长模型"
      />
    </AbsoluteFill>
  );
};
