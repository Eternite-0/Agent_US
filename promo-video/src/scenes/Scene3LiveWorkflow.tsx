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
  springSnappy,
} from "../theme";

const GATES = [
  { id: 1, name: "1. Schema Validation", desc: "强类型参数校验" },
  { id: 2, name: "2. Mandate Check", desc: "任务授权范围核验" },
  { id: 3, name: "3. Path / Net Policy", desc: "仅工作区写入 · 网络关闭" },
  { id: 4, name: "4. Docker Sandbox", desc: "--network none · cap-drop ALL" },
  { id: 5, name: "5. Human Approval", desc: "一次性 Digest + Lease v1 消费" },
  { id: 6, name: "6. Codex PTY Exec", desc: "非 root · 超时 · 有界输出" },
  { id: 7, name: "7. Evidence & Diff", desc: "退出码与变更前后落库审计" },
];

export const Scene3LiveWorkflow: React.FC = () => {
  const frame = useCurrentFrame();
  const duration = 570;
  const envelope = sceneEnvelopeOpacity(frame, duration);
  const headerAnim = fadeInUp(frame, 4, 24);

  // Timeline milestones within local 0..570 frames
  const routerDone = frame >= 85;
  const workerARunning = frame >= 95 && frame < 360;
  const workerBRunning = frame >= 95 && frame < 340;
  const workerApproved = frame >= 270;
  const workerADone = frame >= 360;
  const workerBDone = frame >= 340;
  const mergeDone = frame >= 415;
  const verifierRunning = frame >= 420 && frame < 505;
  const verifierDone = frame >= 505;

  // Animated cursor clicking Approve button around frame 250-275
  const cursorX = interpolate(frame, [205, 255], [1680, 1445], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const cursorY = interpolate(frame, [205, 255], [820, 668], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const cursorVisible = frame >= 200 && frame <= 300;
  const clickRipple =
    frame >= 260 && frame <= 290
      ? interpolate(frame, [260, 290], [0, 1])
      : 0;

  // Helper for edge flow progress
  const edgeProgress = (start: number, end: number) =>
    interpolate(frame, [start, end], [0, 1], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    });

  const p1 = edgeProgress(25, 75);
  const p2a = edgeProgress(85, 130);
  const p2b = edgeProgress(85, 130);
  const p3a = edgeProgress(340, 395);
  const p3b = edgeProgress(340, 395);
  const p4 = edgeProgress(415, 455);

  const renderBadge = (
    status: "queued" | "running" | "waiting" | "completed"
  ) => {
    const map = {
      queued: { label: "QUEUED", bg: "rgba(100,116,139,0.2)", color: "#94A3B8" },
      running: { label: "RUNNING", bg: "rgba(56,189,248,0.2)", color: COLORS.cyan },
      waiting: { label: "AWAITING APPROVAL", bg: "rgba(245,158,11,0.22)", color: COLORS.amber },
      completed: { label: "COMPLETED", bg: "rgba(16,185,129,0.22)", color: COLORS.emeraldBright },
    }[status];
    return (
      <span
        style={{
          fontFamily: FONT_MONO,
          fontSize: 11,
          fontWeight: 700,
          padding: "3px 8px",
          borderRadius: 5,
          backgroundColor: map.bg,
          color: map.color,
          border: `1px solid ${map.color}55`,
        }}
      >
        {map.label}
      </span>
    );
  };

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
          ...headerAnim,
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
              marginBottom: 8,
            }}
          >
            TOPOLOGICAL DAG EXECUTION & 7-STAGE GOVERNANCE
          </div>
          <h2 style={{ margin: 0, fontSize: 42, fontWeight: 800 }}>
            全链路实时运行演示：并行拓扑调度 × 七重零逃逸安全门
          </h2>
        </div>

        <div
          style={{
            fontFamily: FONT_MONO,
            fontSize: 13,
            color: COLORS.textSecondary,
            padding: "8px 14px",
            borderRadius: 10,
            backgroundColor: COLORS.bgCard,
            border: `1px solid ${COLORS.borderSubtle}`,
          }}
        >
          Lease TTL: <strong style={{ color: COLORS.cyan }}>15s</strong> · Heartbeat:{" "}
          <strong style={{ color: COLORS.emeraldBright }}>2s</strong> · Max Concurrency:{" "}
          <strong style={{ color: COLORS.amber }}>4 Workers</strong>
        </div>
      </div>

      {/* LEFT PANEL: Topological DAG */}
      <div
        style={{
          position: "absolute",
          left: 72,
          top: 215,
          width: 890,
          height: 775,
          borderRadius: 20,
          backgroundColor: COLORS.bgPanel,
          border: `1px solid ${COLORS.borderSubtle}`,
          padding: 26,
          ...fadeInUp(frame, 12, 24),
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 16,
          }}
        >
          <span style={{ fontSize: 20, fontWeight: 700 }}>
            1. 拓扑有向无环图 (DAG) 并行工作区
          </span>
          <span
            style={{
              fontFamily: FONT_MONO,
              fontSize: 12,
              color: COLORS.cyan,
            }}
          >
            SQLite BEGIN IMMEDIATE · Worktree Isolated
          </span>
        </div>

        {/* SVG Edges inside Left Panel */}
        <svg
          width={838}
          height={680}
          style={{ position: "absolute", left: 26, top: 72, pointerEvents: "none" }}
        >
          {/* Intent -> Router */}
          <path
            d="M 419 72 L 419 118"
            stroke="rgba(148,163,184,0.2)"
            strokeWidth={3}
          />
          <path
            d="M 419 72 L 419 118"
            stroke={COLORS.cyan}
            strokeWidth={3}
            strokeDasharray={46}
            strokeDashoffset={46 * (1 - p1)}
          />

          {/* Router -> Worker A */}
          <path
            d="M 350 216 C 350 262, 181 245, 181 296"
            fill="none"
            stroke="rgba(148,163,184,0.2)"
            strokeWidth={3}
          />
          <path
            d="M 350 216 C 350 262, 181 245, 181 296"
            fill="none"
            stroke={COLORS.emeraldBright}
            strokeWidth={3}
            strokeDasharray={240}
            strokeDashoffset={240 * (1 - p2a)}
          />

          {/* Router -> Worker B */}
          <path
            d="M 488 216 C 488 262, 585 245, 585 296"
            fill="none"
            stroke="rgba(148,163,184,0.2)"
            strokeWidth={3}
          />
          <path
            d="M 488 216 C 488 262, 585 245, 585 296"
            fill="none"
            stroke={COLORS.violet}
            strokeWidth={3}
            strokeDasharray={220}
            strokeDashoffset={220 * (1 - p2b)}
          />

          {/* Worker A -> Merge */}
          <path
            d="M 181 444 C 181 486, 360 475, 360 512"
            fill="none"
            stroke="rgba(148,163,184,0.2)"
            strokeWidth={3}
          />
          <path
            d="M 181 444 C 181 486, 360 475, 360 512"
            fill="none"
            stroke={COLORS.emeraldBright}
            strokeWidth={3}
            strokeDasharray={225}
            strokeDashoffset={225 * (1 - p3a)}
          />

          {/* Worker B -> Merge */}
          <path
            d="M 585 444 C 585 486, 478 475, 478 512"
            fill="none"
            stroke="rgba(148,163,184,0.2)"
            strokeWidth={3}
          />
          <path
            d="M 585 444 C 585 486, 478 475, 478 512"
            fill="none"
            stroke={COLORS.violet}
            strokeWidth={3}
            strokeDasharray={210}
            strokeDashoffset={210 * (1 - p3b)}
          />

          {/* Merge -> Verifier */}
          <path
            d="M 419 576 L 419 605"
            stroke="rgba(148,163,184,0.2)"
            strokeWidth={3}
          />
          <path
            d="M 419 576 L 419 605"
            stroke={COLORS.amber}
            strokeWidth={3}
            strokeDasharray={30}
            strokeDashoffset={30 * (1 - p4)}
          />

          {/* Rework loop curve */}
          <path
            d="M 670 638 C 808 638, 814 166, 700 166"
            fill="none"
            stroke="rgba(245, 158, 11, 0.45)"
            strokeWidth={2}
            strokeDasharray="6 6"
          />
          <text
            x={808}
            y={408}
            fill={COLORS.amber}
            fontSize={12}
            fontWeight={600}
            fontFamily={FONT_MONO}
            textAnchor="middle"
            transform="rotate(-90 808 408)"
          >
            1 次自动返工闭环 (Rework Loop)
          </text>
        </svg>

        {/* Node 1: User Intent */}
        <div
          style={{
            position: "absolute",
            left: 245,
            top: 72,
            width: 400,
            height: 72,
            borderRadius: 12,
            padding: "12px 18px",
            backgroundColor: "rgba(15, 23, 42, 0.95)",
            border: `1.5px solid ${COLORS.cyan}`,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <div>
            <div style={{ fontSize: 15, fontWeight: 700 }}>POST /api/v1/tasks</div>
            <div style={{ fontSize: 12, color: COLORS.textSecondary, fontFamily: FONT_MONO }}>
              idempotencyKey: "req-8f29c"
            </div>
          </div>
          {renderBadge("completed")}
        </div>

        {/* Node 2: Router Session */}
        <div
          style={{
            position: "absolute",
            left: 165,
            top: 190,
            width: 560,
            height: 98,
            borderRadius: 14,
            padding: "14px 20px",
            backgroundColor: "rgba(15, 23, 42, 0.95)",
            border: `1.5px solid ${routerDone ? COLORS.emeraldBright : COLORS.cyan}`,
            display: "flex",
            flexDirection: "column",
            justifyContent: "space-between",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: 16, fontWeight: 700, whiteSpace: "nowrap" }}>
              Router DSH Session（只做拓扑规划，禁止裸 Shell）
            </span>
            {renderBadge(routerDone ? "completed" : "running")}
          </div>
          <div style={{ fontSize: 13, color: COLORS.textSecondary }}>
            验证节点唯一键与依赖闭包 → 选型路由：Coder (DeepSeek-R1) + Tester (GPT-4.1)
          </div>
        </div>

        {/* Node 3A: Worker A (Coder) */}
        <div
          style={{
            position: "absolute",
            left: 44,
            top: 368,
            width: 326,
            height: 148,
            borderRadius: 14,
            padding: "16px 18px",
            backgroundColor: "rgba(15, 23, 42, 0.96)",
            border: `1.5px solid ${
              workerADone
                ? COLORS.emeraldBright
                : workerARunning && !workerApproved
                ? COLORS.amber
                : COLORS.cyan
            }`,
            boxShadow:
              workerARunning && !workerApproved
                ? "0 0 28px rgba(245, 158, 11, 0.25)"
                : "none",
            display: "flex",
            flexDirection: "column",
            justifyContent: "space-between",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: 16, fontWeight: 700 }}>Worker A · Coder</span>
            {renderBadge(
              workerADone
                ? "completed"
                : workerARunning
                ? workerApproved
                  ? "running"
                  : "waiting"
                : "queued"
            )}
          </div>
          <div style={{ fontSize: 13, color: COLORS.textSecondary, lineHeight: 1.45 }}>
            <div>• 独立 DSH Session + 独占工作快照</div>
            <div>• 触发写文件工具 → 挂起等待一次审批</div>
          </div>
          <div style={{ fontFamily: FONT_MONO, fontSize: 11, color: COLORS.cyan }}>
            Lease: #v1 · Sandbox: docker-none
          </div>
        </div>

        {/* Node 3B: Worker B (Tester) */}
        <div
          style={{
            position: "absolute",
            left: 448,
            top: 368,
            width: 326,
            height: 148,
            borderRadius: 14,
            padding: "16px 18px",
            backgroundColor: "rgba(15, 23, 42, 0.96)",
            border: `1.5px solid ${workerBDone ? COLORS.emeraldBright : COLORS.violet}`,
            display: "flex",
            flexDirection: "column",
            justifyContent: "space-between",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: 16, fontWeight: 700 }}>Worker B · Tester</span>
            {renderBadge(
              workerBDone ? "completed" : workerBRunning ? "running" : "queued"
            )}
          </div>
          <div style={{ fontSize: 13, color: COLORS.textSecondary, lineHeight: 1.45 }}>
            <div>• 并行只读扫描 + 生成边界测试集</div>
            <div>• 零目录冲突（独立 tmpfs 工作区）</div>
          </div>
          <div style={{ fontFamily: FONT_MONO, fontSize: 11, color: COLORS.violet }}>
            Parallel Peak: 2/4 Active Slots
          </div>
        </div>

        {/* Node 4: Artifact Merge */}
        <div
          style={{
            position: "absolute",
            left: 255,
            top: 584,
            width: 380,
            height: 62,
            borderRadius: 12,
            padding: "10px 18px",
            backgroundColor: "rgba(15, 23, 42, 0.95)",
            border: `1.5px solid ${mergeDone ? COLORS.emeraldBright : COLORS.borderSubtle}`,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <div>
            <div style={{ fontSize: 15, fontWeight: 700 }}>不可变产物汇总与交付</div>
            <div style={{ fontSize: 12, color: COLORS.textSecondary, fontFamily: FONT_MONO }}>
              artifacts: proof.txt + patch.diff
            </div>
          </div>
          {renderBadge(mergeDone ? "completed" : "queued")}
        </div>

        {/* Node 5: Independent Verifier Session */}
        <div
          style={{
            position: "absolute",
            left: 195,
            top: 676,
            width: 500,
            height: 78,
            borderRadius: 14,
            padding: "12px 18px",
            backgroundColor: "rgba(15, 23, 42, 0.96)",
            border: `1.5px solid ${
              verifierDone
                ? COLORS.emeraldBright
                : verifierRunning
                ? COLORS.amber
                : COLORS.borderSubtle
            }`,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <div>
            <div style={{ fontSize: 16, fontWeight: 700 }}>
              Independent Verifier Session（独立验收会话）
            </div>
            <div style={{ fontSize: 12, color: COLORS.textSecondary }}>
              核对退出码、Evidence 证据链与验收标准 → 最终裁决发布
            </div>
          </div>
          {renderBadge(
            verifierDone ? "completed" : verifierRunning ? "running" : "queued"
          )}
        </div>
      </div>

      {/* RIGHT PANEL: 7-Stage Security Gate + Live Approval Card */}
      <div
        style={{
          position: "absolute",
          left: 988,
          top: 215,
          width: 860,
          height: 775,
          borderRadius: 20,
          backgroundColor: COLORS.bgPanel,
          border: `1px solid ${COLORS.borderSubtle}`,
          padding: 26,
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          ...fadeInUp(frame, 24, 24),
        }}
      >
        <div>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: 16,
            }}
          >
            <span style={{ fontSize: 20, fontWeight: 700 }}>
              2. 七重安全执行门 (7-Gate Governance Pipeline)
            </span>
            <span
              style={{
                fontFamily: FONT_MONO,
                fontSize: 12,
                color: COLORS.amber,
              }}
            >
              Codex Typed Approval × Docker Container
            </span>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {GATES.map((g, idx) => {
              const gateFrame = 120 + idx * 24;
              const passed =
                idx < 4
                  ? frame >= gateFrame
                  : idx === 4
                  ? workerApproved
                  : idx === 5
                  ? frame >= 315
                  : frame >= 355;
              const active =
                idx === 4 && frame >= 200 && !workerApproved;

              return (
                <div
                  key={g.id}
                  style={{
                    height: 44,
                    borderRadius: 10,
                    padding: "0 14px",
                    backgroundColor: active
                      ? "rgba(245, 158, 11, 0.16)"
                      : passed
                      ? "rgba(16, 185, 129, 0.12)"
                      : "rgba(15, 23, 42, 0.7)",
                    border: `1px solid ${
                      active
                        ? COLORS.amber
                        : passed
                        ? "rgba(16, 185, 129, 0.45)"
                        : COLORS.borderSubtle
                    }`,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <span
                      style={{
                        fontFamily: FONT_MONO,
                        fontSize: 13,
                        fontWeight: 700,
                        color: passed
                          ? COLORS.emeraldBright
                          : active
                          ? COLORS.amber
                          : COLORS.textPrimary,
                      }}
                    >
                      {g.name}
                    </span>
                    <span style={{ fontSize: 13, color: COLORS.textSecondary }}>
                      {g.desc}
                    </span>
                  </div>
                  <span
                    style={{
                      fontFamily: FONT_MONO,
                      fontSize: 12,
                      fontWeight: 700,
                      color: passed
                        ? COLORS.emeraldBright
                        : active
                        ? COLORS.amber
                        : COLORS.textMuted,
                    }}
                  >
                    {passed ? "PASS ✓" : active ? "WAITING" : "PENDING"}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Interactive Approval Card & Live PTY Output */}
        <div
          style={{
            borderRadius: 14,
            padding: 18,
            backgroundColor: "rgba(8, 13, 26, 0.95)",
            border: `1.5px solid ${
              workerApproved ? COLORS.emeraldBright : COLORS.amber
            }`,
            display: "flex",
            flexDirection: "column",
            gap: 12,
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <div style={{ fontFamily: FONT_MONO, fontSize: 13, fontWeight: 700 }}>
              POST /api/v1/approvals/apr_94c2/decision
            </div>
            <span
              style={{
                fontFamily: FONT_MONO,
                fontSize: 11,
                color: workerApproved ? COLORS.emeraldBright : COLORS.amber,
              }}
            >
              {workerApproved
                ? "CONSUMED (SINGLE-USE · VERSION 1)"
                : "DIGEST BOUND · TTL 120s"}
            </span>
          </div>

          <div
            style={{
              fontFamily: FONT_MONO,
              fontSize: 12.5,
              color: "#CBD5E1",
              backgroundColor: "rgba(15, 23, 42, 0.85)",
              padding: "10px 12px",
              borderRadius: 8,
              lineHeight: 1.5,
            }}
          >
            <div>
              <span style={{ color: COLORS.cyan }}>tool:</span> "codex_exec" ·{" "}
              <span style={{ color: COLORS.cyan }}>container:</span>{" "}
              "--network none --read-only --cap-drop ALL"
            </div>
            <div>
              <span style={{ color: COLORS.cyan }}>digest:</span>{" "}
              "sha256:7d9a...e31b" · <span style={{ color: COLORS.cyan }}>cmd:</span>{" "}
              "node scripts/build_proof.mjs &gt; proof.txt"
            </div>
          </div>

          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <div style={{ fontSize: 13, color: COLORS.textSecondary }}>
              拒绝/过期自动返回 <strong style={{ color: COLORS.textPrimary }}>409 Conflict</strong>，杜绝越权复用
            </div>

            <div
              style={{
                position: "relative",
                padding: "9px 22px",
                borderRadius: 9,
                fontWeight: 700,
                fontSize: 14,
                backgroundColor: workerApproved
                  ? COLORS.emerald
                  : COLORS.amber,
                color: "#041014",
                transform:
                  frame >= 256 && frame <= 268 ? "scale(0.94)" : "scale(1)",
              }}
            >
              {workerApproved ? "已批准 · 凭证原子核销 ✓" : "批准执行 (Approve v1)"}
              {clickRipple > 0 && (
                <div
                  style={{
                    position: "absolute",
                    inset: -8 * clickRipple,
                    borderRadius: 14,
                    border: `2px solid ${COLORS.emeraldBright}`,
                    opacity: 1 - clickRipple,
                  }}
                />
              )}
            </div>
          </div>

          {/* Evidence Output Box */}
          <div
            style={{
              height: 110,
              borderRadius: 9,
              padding: "10px 14px",
              backgroundColor: "#03060E",
              border: "1px solid rgba(56, 189, 248, 0.22)",
              fontFamily: FONT_MONO,
              fontSize: 12.5,
              lineHeight: 1.55,
              color: "#94A3B8",
              overflow: "hidden",
            }}
          >
            {frame < 290 ? (
              <div style={{ color: COLORS.amber }}>
                [gate] Waiting for explicit human decision on digest sha256:7d9a...e31b
              </div>
            ) : (
              <>
                <div style={{ color: COLORS.cyan }}>
                  $ docker run --rm --network none --read-only --user 1000:1000 worker-img
                </div>
                {frame >= 315 && (
                  <div style={{ color: "#E2E8F0" }}>
                    [codex/pty] exitCode=0 · uid=1000(sandbox) · net_if=lo_only
                  </div>
                )}
                {frame >= 345 && (
                  <div style={{ color: COLORS.emeraldBright }}>
                    [evidence] Captured diff (+42/-4) &amp; immutable artifact proof.txt (SHA256 verified)
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      {/* Animated Cursor */}
      {cursorVisible && (
        <svg
          width={32}
          height={32}
          viewBox="0 0 24 24"
          style={{
            position: "absolute",
            left: cursorX,
            top: cursorY,
            zIndex: 60,
            filter: "drop-shadow(0 4px 10px rgba(0,0,0,0.65))",
            pointerEvents: "none",
          }}
        >
          <path
            d="M4 2 L4 19 L9 14.5 L12.5 21.5 L15 20.2 L11.5 13.2 L18.5 13.2 Z"
            fill="#FFFFFF"
            stroke="#0F172A"
            strokeWidth={1.6}
          />
        </svg>
      )}
    </div>
  );
};
