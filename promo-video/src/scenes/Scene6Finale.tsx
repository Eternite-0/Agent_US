import React from "react";
import { interpolate, useCurrentFrame } from "remotion";
import {
  COLORS,
  FONT_MONO,
  FONT_SANS,
  HEIGHT,
  WIDTH,
  fadeInUp,
  sceneEnvelopeOpacity,
  springSmooth,
  springSnappy,
} from "../theme";

const PILLARS = [
  {
    title: "可组合 DSH + SuperAgent 引擎",
    desc: "Cordis 插件底座 + 持久化 DAG + 15s 租约恢复",
    color: COLORS.violet,
  },
  {
    title: "Codex 级物理沙箱与审批门",
    desc: "Docker --network none · 一次性 Digest 核销 · PTY",
    color: COLORS.cyan,
  },
  {
    title: "Magpie + 原生双路网关",
    desc: "AES-256-GCM 密封密钥 · 127.0.0.1:3425 秒切容灾",
    color: COLORS.magpie,
  },
  {
    title: "Codex 1:1 Electron 桌面交付",
    desc: "SSE 断点重放 · Extension Hub · 40×40 Diff 审查",
    color: COLORS.emeraldBright,
  },
];

export const Scene6Finale: React.FC = () => {
  const frame = useCurrentFrame();
  const duration = 270;
  const envelope = sceneEnvelopeOpacity(frame, duration, 14, 10);

  const mockupScale = springSmooth(frame, 6);
  const diffExpand = interpolate(frame, [52, 96], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const glowPulse = 0.6 + 0.4 * Math.sin(frame * 0.14);

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        width: WIDTH,
        height: HEIGHT,
        opacity: envelope,
        fontFamily: FONT_SANS,
        color: COLORS.textPrimary,
      }}
    >
      {/* Header */}
      <div
        style={{
          position: "absolute",
          top: 96,
          left: 72,
          right: 72,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-end",
          ...fadeInUp(frame, 4, 20),
        }}
      >
        <div>
          <div
            style={{
              fontFamily: FONT_MONO,
              fontSize: 13,
              color: COLORS.cyan,
              letterSpacing: "0.14em",
              fontWeight: 700,
              marginBottom: 8,
            }}
          >
            CODEX 1:1 DESKTOP & FINAL ARCHITECTURAL LOCKUP
          </div>
          <h2 style={{ margin: 0, fontSize: 42, fontWeight: 800 }}>
            端到端生产交付：Codex 1:1 桌面端 × 全栈自治底座
          </h2>
        </div>

        <div
          style={{
            fontFamily: FONT_MONO,
            fontSize: 13,
            color: COLORS.emeraldBright,
            padding: "8px 16px",
            borderRadius: 10,
            backgroundColor: "rgba(16, 185, 129, 0.14)",
            border: "1px solid rgba(16, 185, 129, 0.4)",
            fontWeight: 700,
          }}
        >
          Electron 35 · React · TypeScript · SQLite WAL
        </div>
      </div>

      {/* LEFT: Codex 1:1 Desktop Mockup */}
      <div
        style={{
          position: "absolute",
          left: 72,
          top: 215,
          width: 1040,
          height: 755,
          borderRadius: 20,
          backgroundColor: "#0B101C",
          border: `1.5px solid rgba(56, 189, 248, 0.35)`,
          boxShadow: "0 24px 60px rgba(0,0,0,0.65)",
          overflow: "hidden",
          transform: `scale(${interpolate(mockupScale, [0, 1], [0.93, 1])})`,
          opacity: mockupScale,
          display: "flex",
          flexDirection: "column",
        }}
      >
        {/* Window Top Chrome */}
        <div
          style={{
            height: 46,
            padding: "0 18px",
            backgroundColor: "#0F172A",
            borderBottom: `1px solid ${COLORS.borderSubtle}`,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ display: "flex", gap: 7 }}>
              <div style={{ width: 11, height: 11, borderRadius: 99, backgroundColor: "#EF4444" }} />
              <div style={{ width: 11, height: 11, borderRadius: 99, backgroundColor: "#F59E0B" }} />
              <div style={{ width: 11, height: 11, borderRadius: 99, backgroundColor: "#10B981" }} />
            </div>
            <span style={{ fontSize: 13, fontWeight: 700, marginLeft: 8 }}>
              Agent_US Desktop
            </span>
            <span
              style={{
                fontFamily: FONT_MONO,
                fontSize: 11,
                color: COLORS.textSecondary,
                padding: "2px 8px",
                borderRadius: 5,
                backgroundColor: "rgba(148,163,184,0.12)",
              }}
            >
              Ctrl+K 命令面板
            </span>
          </div>

          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "4px 12px",
              borderRadius: 99,
              backgroundColor: "rgba(16, 185, 129, 0.15)",
              border: "1px solid rgba(16, 185, 129, 0.4)",
              fontFamily: FONT_MONO,
              fontSize: 11.5,
              color: COLORS.emeraldBright,
            }}
          >
            <div
              style={{
                width: 7,
                height: 7,
                borderRadius: 99,
                backgroundColor: COLORS.emeraldBright,
              }}
            />
            Magpie Gateway Connected · 127.0.0.1:3425
          </div>
        </div>

        {/* Body: Sidebar + Main Thread */}
        <div style={{ flex: 1, display: "flex" }}>
          {/* Sidebar */}
          <div
            style={{
              width: 248,
              backgroundColor: "#080D18",
              borderRight: `1px solid ${COLORS.borderSubtle}`,
              padding: 16,
              display: "flex",
              flexDirection: "column",
              gap: 10,
            }}
          >
            <div
              style={{
                fontFamily: FONT_MONO,
                fontSize: 11,
                color: COLORS.textMuted,
                letterSpacing: "0.08em",
              }}
            >
              THREADS & TASKS
            </div>
            {[
              { title: "DAG 并行重构鉴权模块", active: true, status: "COMPLETED" },
              { title: "Docker PTY 安全基线扫描", active: false, status: "VERIFIED" },
              { title: "Magpie 多路由压测任务", active: false, status: "READY" },
              { title: "Extension Hub 插件同步", active: false, status: "SYNCED" },
            ].map((item) => (
              <div
                key={item.title}
                style={{
                  padding: "10px 12px",
                  borderRadius: 10,
                  backgroundColor: item.active
                    ? "rgba(56, 189, 248, 0.14)"
                    : "rgba(15, 23, 42, 0.6)",
                  border: item.active
                    ? "1px solid rgba(56, 189, 248, 0.4)"
                    : "1px solid transparent",
                }}
              >
                <div style={{ fontSize: 13, fontWeight: 600 }}>{item.title}</div>
                <div
                  style={{
                    fontFamily: FONT_MONO,
                    fontSize: 10.5,
                    color: item.active ? COLORS.cyan : COLORS.emeraldBright,
                    marginTop: 4,
                  }}
                >
                  {item.status}
                </div>
              </div>
            ))}
          </div>

          {/* Main Thread Workspace */}
          <div
            style={{
              flex: 1,
              padding: 22,
              display: "flex",
              flexDirection: "column",
              gap: 14,
            }}
          >
            {/* DAG Progress Header */}
            <div
              style={{
                padding: "12px 16px",
                borderRadius: 12,
                backgroundColor: "rgba(15, 23, 42, 0.85)",
                border: `1px solid ${COLORS.borderSubtle}`,
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ fontSize: 14, fontWeight: 700 }}>
                  DAG 规划 · 4/4 节点完成
                </span>
                <span
                  style={{
                    fontFamily: FONT_MONO,
                    fontSize: 11.5,
                    color: COLORS.cyan,
                  }}
                >
                  SSE Last-Event-ID: #428
                </span>
              </div>
              <span
                style={{
                  fontFamily: FONT_MONO,
                  fontSize: 12,
                  color: COLORS.emeraldBright,
                }}
              >
                Verifier Accepted ✓
              </span>
            </div>

            {/* 12.5px Command Execution Card */}
            <div
              style={{
                borderRadius: 12,
                backgroundColor: "#050811",
                border: "1px solid rgba(56, 189, 248, 0.25)",
                padding: "12px 16px",
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  fontFamily: FONT_MONO,
                  fontSize: 12.5,
                  color: COLORS.cyan,
                  marginBottom: 8,
                }}
              >
                <span>$ npm run test:integration (Docker Worker #A)</span>
                <span style={{ color: COLORS.emeraldBright }}>exit 0 · 35.6s</span>
              </div>
              <div
                style={{
                  fontFamily: FONT_MONO,
                  fontSize: 12,
                  color: "#CBD5E1",
                  lineHeight: 1.5,
                }}
              >
                <div>✓ 14/14 suites passed (0 failed, 0 skipped)</div>
                <div>✓ Zero-network container isolation &amp; SIGKILL lease recovery verified</div>
              </div>
            </div>

            {/* 40x40 File Change Diff Resource Card */}
            <div
              style={{
                borderRadius: 12,
                backgroundColor: "rgba(15, 23, 42, 0.88)",
                border: `1px solid rgba(16, 185, 129, 0.35)`,
                padding: 14,
                display: "flex",
                flexDirection: "column",
                gap: 10,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                <div
                  style={{
                    width: 40,
                    height: 40,
                    borderRadius: 10,
                    backgroundColor: "rgba(16, 185, 129, 0.16)",
                    border: "1px solid rgba(16, 185, 129, 0.45)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontFamily: FONT_MONO,
                    fontWeight: 800,
                    fontSize: 13,
                    color: COLORS.emeraldBright,
                  }}
                >
                  DIFF
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 14.5, fontWeight: 700 }}>
                    backend/src/engine.js · 产物 Diff 审查
                  </div>
                  <div
                    style={{
                      fontFamily: FONT_MONO,
                      fontSize: 12,
                      color: COLORS.textSecondary,
                    }}
                  >
                    +48 lines / -6 lines · SHA256 Evidence Bound
                  </div>
                </div>
                <span
                  style={{
                    fontFamily: FONT_MONO,
                    fontSize: 11.5,
                    color: COLORS.emeraldBright,
                  }}
                >
                  +48 -6
                </span>
              </div>

              <div
                style={{
                  height: Math.round(92 * diffExpand),
                  overflow: "hidden",
                  borderRadius: 8,
                  backgroundColor: "#04070F",
                  padding: diffExpand > 0.1 ? "8px 12px" : "0 12px",
                  fontFamily: FONT_MONO,
                  fontSize: 11.5,
                  lineHeight: 1.55,
                }}
              >
                <div style={{ color: "#34D399" }}>
                  + const lease = store.acquireLease(jobId, fencingToken, 15_000);
                </div>
                <div style={{ color: "#34D399" }}>
                  + const evidence = await sandbox.execCodexPty(approvalDigest);
                </div>
                <div style={{ color: "#34D399" }}>
                  + store.publishArtifactOnce(assignmentId, lease.token, evidence);
                </div>
              </div>
            </div>

            {/* Bottom Approval Banner */}
            <div
              style={{
                marginTop: "auto",
                padding: "12px 16px",
                borderRadius: 12,
                backgroundColor: "rgba(16, 185, 129, 0.12)",
                border: "1px solid rgba(16, 185, 129, 0.35)",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                fontSize: 13.5,
              }}
            >
              <span>一次性审批已原子核销 · 独立验收会话已归档交付产物</span>
              <span
                style={{
                  fontFamily: FONT_MONO,
                  fontWeight: 700,
                  color: COLORS.emeraldBright,
                }}
              >
                READY FOR PRODUCTION
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* RIGHT: Final Brand Lockup & 4 Architectural Pillars */}
      <div
        style={{
          position: "absolute",
          left: 1144,
          top: 215,
          width: 704,
          height: 755,
          borderRadius: 22,
          padding: "32px 34px",
          backgroundColor: "rgba(11, 20, 38, 0.94)",
          border: `1.5px solid rgba(16, 185, 129, ${0.35 + glowPulse * 0.35})`,
          boxShadow: "0 0 60px rgba(16, 185, 129, 0.16)",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          ...fadeInUp(frame, 18, 24),
        }}
      >
        <div>
          <div
            style={{
              fontFamily: FONT_MONO,
              fontSize: 13,
              color: COLORS.emeraldBright,
              letterSpacing: "0.14em",
              fontWeight: 700,
            }}
          >
            WHY AGENT_US WINS
          </div>
          <h3
            style={{
              margin: "8px 0 0 0",
              fontSize: 48,
              fontWeight: 900,
              letterSpacing: "-0.02em",
              background: `linear-gradient(95deg, #FFFFFF 15%, ${COLORS.cyan} 65%, ${COLORS.emeraldBright} 100%)`,
              WebkitBackgroundClip: "text",
              WebkitTextFillColor: "transparent",
            }}
          >
            AGENT_US
          </h3>
          <p
            style={{
              margin: "10px 0 0 0",
              fontSize: 17,
              color: COLORS.textSecondary,
              lineHeight: 1.5,
            }}
          >
            集 DSH 可组合内核、Claude 治理模式、Codex 执行边界与 Magpie 多网关容灾于一体，定义企业级 Agent 新基准。
          </p>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {PILLARS.map((p, idx) => {
            const anim = springSnappy(frame, 36 + idx * 18);
            return (
              <div
                key={p.title}
                style={{
                  padding: "16px 20px",
                  borderRadius: 14,
                  backgroundColor: "rgba(15, 23, 42, 0.88)",
                  border: `1px solid ${p.color}50`,
                  opacity: anim,
                  transform: `translateX(${(1 - anim) * 28}px)`,
                }}
              >
                <div
                  style={{
                    fontSize: 17,
                    fontWeight: 700,
                    color: p.color,
                    marginBottom: 4,
                  }}
                >
                  ◆ {p.title}
                </div>
                <div style={{ fontSize: 14, color: "#E2E8F0" }}>{p.desc}</div>
              </div>
            );
          })}
        </div>

        <div
          style={{
            padding: "16px 20px",
            borderRadius: 14,
            background:
              "linear-gradient(90deg, rgba(56,189,248,0.16), rgba(16,185,129,0.18))",
            border: "1px solid rgba(56, 189, 248, 0.4)",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <div>
            <div style={{ fontSize: 16, fontWeight: 800 }}>
              d:\Agent_US · 全栈架构就绪
            </div>
            <div
              style={{
                fontFamily: FONT_MONO,
                fontSize: 12.5,
                color: COLORS.cyan,
                marginTop: 2,
              }}
            >
              backend · frontend · desktop · agent_research_delivery
            </div>
          </div>
          <div
            style={{
              fontFamily: FONT_MONO,
              fontSize: 14,
              fontWeight: 800,
              color: COLORS.emeraldBright,
            }}
          >
            100% VERIFIED ✓
          </div>
        </div>
      </div>
    </div>
  );
};
